/**
 * @module meme_manager
 * @description Manages net meme data (text + audio pairs) stored in chrome.storage.local.
 */

// @ts-expect-error
self.browser ??= chrome;

/**
 * @typedef MemeEntry
 * @prop {string} id Unique identifier for the meme
 * @prop {string} text The meme text to display as a comment
 * @prop {string} audioDataUrl Base64-encoded audio data URL (data:audio/...;base64,...)
 * @prop {string} [color] Optional custom color for the meme text
 * @prop {boolean} enabled Whether this meme is active
 */

const STORAGE_KEY = 'memes';

/**
 * Loads default meme presets from assets/default_memes.json
 * @returns {Promise<MemeEntry[]>}
 */
export async function loadDefaultMemes() {
	try {
		const url = browser.runtime.getURL('assets/default_memes.json');
		const res = await fetch(url);
		if (!res.ok) return [];
		const raw = await res.json();
		return raw.map(item => ({
			id: item.id || `preset_${item.text}`,
			text: item.text,
			audioDataUrl: item.audioFile ? browser.runtime.getURL(item.audioFile) : (item.audioDataUrl || ''),
			color: item.color || '',
			enabled: item.enabled ?? true,
			isPreset: true,
		}));
	} catch (e) {
		console.warn('Failed to load default memes:', e);
		return [];
	}
}

/**
 * Saves all memes to storage.
 * @param {MemeEntry[]} memes array of meme entries
 */
export async function saveMemes(memes) {
	await browser.storage.local.set({ [STORAGE_KEY]: memes });
}

/**
 * Loads all memes from storage merged with default presets.
 * @returns {Promise<MemeEntry[]>} array of meme entries
 */
export async function loadMemes() {
	const data = await browser.storage.local.get(STORAGE_KEY);
	const userMemes = data[STORAGE_KEY];
	const defaults = await loadDefaultMemes();

	if (!userMemes || userMemes.length === 0) {
		// Initialize storage with defaults on first load
		await saveMemes(defaults);
		return defaults;
	}

	const defaultsMap = new Map(defaults.map(d => [d.id, d]));
	let updated = false;

	// Update audio URLs for existing presets if default_memes changed
	for (const meme of userMemes) {
		if ((meme.isPreset || meme.id.startsWith('preset_')) && defaultsMap.has(meme.id)) {
			const def = defaultsMap.get(meme.id);
			if (def && meme.audioDataUrl !== def.audioDataUrl) {
				meme.audioDataUrl = def.audioDataUrl;
				updated = true;
			}
		}
	}

	// Always ensure any newly added preset in default_memes.json exists unless explicitly saved
	const existingIds = new Set(userMemes.map(m => m.id));
	for (const preset of defaults) {
		if (!existingIds.has(preset.id)) {
			userMemes.push(preset);
			updated = true;
		}
	}
	if (updated) {
		await saveMemes(userMemes);
	}

	return userMemes;
}

/**
 * Adds a new meme entry.
 * @param {Omit<MemeEntry, 'id'>} entry meme data without id
 * @returns {Promise<MemeEntry>} the created meme entry with generated id
 */
export async function addMeme(entry) {
	const memes = await loadMemes();
	/** @type {MemeEntry} */
	const meme = {
		id: `meme_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		text: entry.text,
		audioDataUrl: entry.audioDataUrl,
		color: entry.color || '',
		enabled: entry.enabled ?? true,
	};
	memes.push(meme);
	await saveMemes(memes);
	return meme;
}

/**
 * Removes a meme by id.
 * @param {string} id meme id to remove
 * @returns {Promise<boolean>} true if the meme was found and removed
 */
export async function removeMeme(id) {
	const memes = await loadMemes();
	const index = memes.findIndex(m => m.id === id);
	if (index < 0) return false;
	memes.splice(index, 1);
	await saveMemes(memes);
	return true;
}

/**
 * Toggles a meme's enabled state.
 * @param {string} id meme id
 * @returns {Promise<boolean>} new enabled state
 */
export async function toggleMeme(id) {
	const memes = await loadMemes();
	const meme = memes.find(m => m.id === id);
	if (!meme) return false;
	meme.enabled = !meme.enabled;
	await saveMemes(memes);
	return meme.enabled;
}

/**
 * Gets only enabled memes.
 * @returns {Promise<MemeEntry[]>} array of enabled meme entries
 */
export async function getEnabledMemes() {
	const memes = await loadMemes();
	return memes.filter(m => m.enabled);
}

/**
 * Reads a File as a data URL string.
 * @param {File} file audio file
 * @returns {Promise<string>} data URL string
 */
export function readFileAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(/** @type {string} */ (reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
