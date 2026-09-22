/**
 * @module meme_injector
 * @description Injects meme comments into the danmaku layer at random intervals.
 *              Uses Gemini API (if API key is configured) to pick the best meme
 *              based on recent live chat content. Falls back to Math.random().
 *              Automatically pauses injection while YouTube ads are playing.
 */

import { getEnabledMemes } from './meme_manager.mjs';
import { layoutChatItem } from './chat_layout.mjs';
import { store as s } from './store.mjs';
import { isAdShowing } from './utils.mjs';

// meme_ai.mjs is loaded lazily via dynamic import so a failure in that module
// does NOT cascade and break the entire chat rendering pipeline.
/** @type {typeof import('./meme_ai.mjs').selectMemeWithAI | null} */
let selectMemeWithAI = null;
import('./meme_ai.mjs').then(m => {
	selectMemeWithAI = m.selectMemeWithAI;
}).catch(err => {
	console.warn('[MEME-AI] Failed to load meme_ai.mjs; AI selection disabled.', err);
});

/**
 * Creates a meme comment element.
 * @param {import('./meme_manager.mjs').MemeEntry} meme meme data
 * @returns {HTMLDivElement} meme element
 */
function createMemeElement(meme) {
	const el = document.createElement('div');
	el.classList.add('text', 'meme');
	el.id = `meme_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	el.dataset.memeId = meme.id;
	el.dataset.audioUrl = meme.audioDataUrl || meme.audioUrl || '';
	el.dataset.text = meme.text;

	// Build the inner structure similar to 'text' template
	const header = document.createElement('span');
	header.classList.add('header');

	const body = document.createElement('span');
	body.classList.add('body');
	body.textContent = meme.text;

	el.append(header, body);

	// Save custom color to dataset for when played
	if (meme.color) {
		el.dataset.color = meme.color;
	}

	return el;
}

export class MemeInjector {
	/** @type {number | ReturnType<typeof setTimeout>} */
	#intervalId = 0;

	/** @type {import('./chat_layer.mjs').LiveChatLayer} */
	#layer;

	/** @type {import('./chat_layout.mjs').LiveChatLayoutCache} */
	#layoutCache;

	/** @type {number} base interval in ms between meme injections */
	#intervalMs;

	/** @type {import('./meme_manager.mjs').MemeEntry[]} cached enabled memes */
	#memes = [];

	/**
	 * Ring buffer of recent chat texts (newest first, max 20 entries).
	 * @type {string[]}
	 */
	#recentChatTexts = [];

	/** @type {boolean} whether the injector loop is running */
	#running = false;

	/**
	 * The YouTube player element used for ad detection.
	 * @type {HTMLElement | null}
	 */
	#player = null;

	/**
	 * @param {import('./chat_layer.mjs').LiveChatLayer} layer danmaku layer
	 * @param {import('./chat_layout.mjs').LiveChatLayoutCache} layoutCache layout cache
	 * @param {number} [intervalMs=8000] base interval between meme injections in ms
	 * @param {HTMLElement | null} [player] YouTube player element for ad detection
	 */
	constructor(layer, layoutCache, intervalMs = 8000, player = null) {
		this.#layer = layer;
		this.#layoutCache = layoutCache;
		this.#intervalMs = intervalMs;
		this.#player = player;
	}

	/**
	 * Adds a chat text to the recent chat ring buffer.
	 * Call this from the controller whenever a new chat message is rendered.
	 * @param {string} text raw chat message text
	 */
	addChatText(text) {
		if (!text?.trim()) return;
		this.#recentChatTexts.unshift(text.trim());
		if (this.#recentChatTexts.length > 20) {
			this.#recentChatTexts.length = 20;
		}
	}

	/**
	 * Starts injecting memes at random intervals.
	 */
	async start() {
		this.stop();
		await this.#refreshMemes();

		if (this.#memes.length === 0) return;

		this.#running = true;
		this.#scheduleNext();
	}

	/**
	 * Schedules the next meme injection with a random jitter applied to the base interval.
	 */
	#scheduleNext() {
		if (!this.#running) return;
		// Random ±50% jitter: base=8000ms → range 4000〜12000ms
		const jitter = this.#intervalMs * 0.5;
		const delay = this.#intervalMs + (Math.random() * jitter * 2 - jitter);
		this.#intervalId = setTimeout(async () => {
			await this.#injectMeme();
			this.#scheduleNext();
		}, delay);
	}

	/**
	 * Stops meme injection.
	 */
	stop() {
		this.#running = false;
		if (this.#intervalId) {
			clearTimeout(this.#intervalId);
			this.#intervalId = 0;
		}
	}

	/**
	 * Refreshes the cached list of enabled memes from storage.
	 */
	async #refreshMemes() {
		this.#memes = await getEnabledMemes();
	}

	/**
	 * Injects one meme. Skips if:
	 *  - layer is hidden
	 *  - a YouTube ad is currently playing
	 * Tries AI selection first; falls back to random.
	 */
	async #injectMeme() {
		if (this.#memes.length === 0) return;
		if (this.#layer.element.hidden) return;

		// Ad guard: skip meme during YouTube ads (reuses existing utils.mjs helper)
		if (this.#player && isAdShowing(this.#player)) {
			console.info('[MEME] Ad detected — skipping meme injection.');
			return;
		}

		const meme = await this.#selectMeme();
		if (!meme) return;

		const el = createMemeElement(meme);

		/** @type {["dense", "random"]} */
		const modeOptions = ['dense', 'random'];
		layoutChatItem(el, this.#layoutCache, modeOptions[s.others.density]);

		if (this.#layer.controller && typeof this.#layer.controller.spawnedMemeCount === 'number') {
			this.#layer.controller.spawnedMemeCount++;
		}
	}

	/**
	 * Selects a meme via Gemini AI if an API key is configured and enough chat
	 * context has been gathered; otherwise falls back to Math.random().
	 * @returns {Promise<import('./meme_manager.mjs').MemeEntry | null>}
	 */
	async #selectMeme() {
		const apiKey = s.others.gemini_api_key ?? '';

		if (selectMemeWithAI && apiKey && this.#recentChatTexts.length >= 3) {
			try {
				const selectedId = await selectMemeWithAI(
					this.#recentChatTexts,
					this.#memes,
					apiKey,
				);
				if (selectedId) {
					return this.#memes.find(m => m.id === selectedId) ?? this.#randomMeme();
				}
			} catch (err) {
				console.warn('[MEME-AI] selectMemeWithAI error, falling back to random:', err);
			}
		}

		return this.#randomMeme();
	}

	/**
	 * Returns a uniformly random meme from the cache.
	 * @returns {import('./meme_manager.mjs').MemeEntry}
	 */
	#randomMeme() {
		return this.#memes[Math.floor(Math.random() * this.#memes.length)];
	}

	/**
	 * Sets the injection interval.
	 * @param {number} ms base interval in milliseconds
	 */
	setInterval(ms) {
		this.#intervalMs = ms;
		if (this.#running) {
			this.start(); // restart with new interval
		}
	}

	/**
	 * Plays the audio associated with a meme element.
	 * @param {HTMLElement} memeElement the meme element that was clicked
	 * @param {HTMLVideoElement|null} videoElement the main video element to duck volume
	 * @returns {?HTMLAudioElement} the created audio element, or null if the meme has no audio
	 */
	static playAudio(memeElement, videoElement) {
		const audioUrl = memeElement.dataset.audioUrl;
		if (!audioUrl) return null;

		const audio = new Audio(audioUrl);
		audio.volume = 1.0; // Play meme loudly

		let originalVolume = 1.0;
		if (videoElement) {
			originalVolume = videoElement.volume;
			// Lower the video volume to 20% of its original volume
			videoElement.volume = originalVolume * 0.2;
		}

		audio.onended = () => {
			if (videoElement) {
				videoElement.volume = originalVolume;
			}
		};
		// Also restore volume if there's an error or it gets paused somehow
		audio.onpause = audio.onerror = () => {
			if (videoElement && videoElement.volume < originalVolume) {
				videoElement.volume = originalVolume;
			}
		};

		audio.play().catch(err => {
			console.warn('Failed to play meme audio:', err);
			if (videoElement) {
				videoElement.volume = originalVolume;
			}
		});

		return audio;
	}
}
