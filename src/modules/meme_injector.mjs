/**
 * @module meme_injector
 * @description Injects meme comments into the danmaku layer at random intervals.
 */

import { getEnabledMemes } from './meme_manager.mjs';
import { layoutChatItem } from './chat_layout.mjs';
import { store as s } from './store.mjs';

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
	 * @param {import('./chat_layer.mjs').LiveChatLayer} layer danmaku layer
	 * @param {import('./chat_layout.mjs').LiveChatLayoutCache} layoutCache layout cache
	 */
	constructor(layer, layoutCache) {
		this.#layer = layer;
		this.#layoutCache = layoutCache;
	}

	/**
	 * Starts injecting memes at randomized intervals.
	 */
	async start() {
		this.stop();
		await this.#refreshMemes();

		if (this.#memes.length === 0) return;

		this.#scheduleNext();
	}

	/**
	 * Stops meme injection.
	 */
	stop() {
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
		const min = Math.max(0, s.others.meme_interval_min ?? 3) * 1000;
		const max = Math.max(min, (s.others.meme_interval_max ?? 15) * 1000);
		const delay = min + Math.random() * (max - min);
		this.#timerId = setTimeout(() => {
			this.#injectBatch();
			this.#scheduleNext();
		}, delay);
	}

	/**
	 * Injects a randomly-sized batch of memes (weighted toward smaller counts).
	 */
	#injectBatch() {
		if (this.#memes.length === 0) return;
		if (this.#layer.element.hidden) return;

		const maxBatch = Math.max(1, s.others.meme_batch_max ?? 3);
		const count = pickWeightedBatchSize(maxBatch);
		for (let i = 0; i < count; i++) {
			this.#injectRandomMeme();
		}
	}

	/**
	 * Injects a single random meme into the layer.
	 */
	#injectRandomMeme() {
		const meme = this.#memes[Math.floor(Math.random() * this.#memes.length)];
		const el = createMemeElement(meme);

		/** @type {["dense", "random"]} */
		const modeOptions = ['dense', 'random'];
		layoutChatItem(el, this.#layoutCache, modeOptions[s.others.density]);

		if (this.#layer.controller && typeof this.#layer.controller.spawnedMemeCount === 'number') {
			this.#layer.controller.spawnedMemeCount++;
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
