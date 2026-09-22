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

/**
 * Picks a batch size from 1..max, weighted so smaller counts (especially 1) are far more likely
 * (weight for size k is 2^(max-k), so 1 is always the most likely outcome).
 * @param {number} max maximum batch size (inclusive)
 * @returns {number}
 */
function pickWeightedBatchSize(max) {
	const weights = Array.from({ length: max }, (_, i) => 2 ** (max - 1 - i));
	const total = weights.reduce((a, b) => a + b, 0);
	let r = Math.random() * total;
	for (let k = 0; k < max; k++) {
		r -= weights[k];
		if (r < 0) return k + 1;
	}
	return max;
}

export class MemeInjector {
	/** @type {number} */
	#timerId = 0;

	/** @type {import('./chat_layer.mjs').LiveChatLayer} */
	#layer;

	/** @type {import('./chat_layout.mjs').LiveChatLayoutCache} */
	#layoutCache;

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
	 * @param {HTMLElement | null} [player] YouTube player element for ad detection
	 */
	constructor(layer, layoutCache, player = null) {
		this.#layer = layer;
		this.#layoutCache = layoutCache;
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
	 * Starts injecting memes at randomized intervals.
	 */
	async start() {
		this.stop();
		await this.#refreshMemes();

		if (this.#memes.length === 0) return;

		this.#running = true;
		this.#scheduleNext();
	}

	/**
	 * Stops meme injection.
	 */
	stop() {
		this.#running = false;
		if (this.#timerId) {
			clearTimeout(this.#timerId);
			this.#timerId = 0;
		}
	}

	/**
	 * Refreshes the cached list of enabled memes from storage.
	 */
	async #refreshMemes() {
		this.#memes = await getEnabledMemes();
	}

	/**
	 * Schedules the next injection after a randomized delay, re-drawing the delay each time.
	 */
	#scheduleNext() {
		if (!this.#running) return;
		const min = Math.max(0, s.others.meme_interval_min ?? 3) * 1000;
		const max = Math.max(min, (s.others.meme_interval_max ?? 15) * 1000);
		const delay = min + Math.random() * (max - min);
		this.#timerId = setTimeout(async () => {
			this.#timerId = 0;
			await this.#injectBatch();
			this.#scheduleNext();
		}, delay);
	}

	/**
	 * Injects a randomly-sized batch of memes (weighted toward smaller counts).
	 */
	async #injectBatch() {
		if (this.#memes.length === 0) return;
		if (this.#layer.element.hidden) return;
		if (this.#player && isAdShowing(this.#player)) {
			console.info('[MEME] Ad detected — skipping meme injection.');
			return;
		}

		const maxBatch = Math.max(1, s.others.meme_batch_max ?? 3);
		const count = pickWeightedBatchSize(maxBatch);
		for (let i = 0; i < count; i++) {
			// Use at most one Gemini request per batch. Additional items stay random.
			const meme = i === 0 ? await this.#selectMeme() : this.#randomMeme();
			if (meme) this.#injectMeme(meme);
		}
	}

	/**
	 * Injects a single meme into the layer.
	 * @param {import('./meme_manager.mjs').MemeEntry} meme meme data
	 */
	#injectMeme(meme) {
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
		if (this.#recentChatTexts.length >= 3) {
			try {
				const response = await browser.runtime.sendMessage({
					memeSelection: {
						recentChats: this.#recentChatTexts,
						memes: this.#memes.map(({ id, text }) => ({ id, text })),
					},
				});
				const selectedId = response?.selectedId;
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
	 * Plays the audio associated with a meme element. Multiple calls can overlap; video volume
	 * ducking (if desired) is the caller's responsibility so overlapping plays don't fight over it.
	 * @param {HTMLElement} memeElement the meme element that was clicked or missed
	 * @returns {?HTMLAudioElement} the created audio element, or null if the meme has no audio
	 */
	static playAudio(memeElement) {
		const audioUrl = memeElement.dataset.audioUrl;
		if (!audioUrl) return null;

		const audio = new Audio(audioUrl);
		audio.volume = 1.0; // Play meme loudly
		audio.play().catch(err => {
			console.warn('Failed to play meme audio:', err);
		});

		return audio;
	}
}
