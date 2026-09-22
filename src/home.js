// @ts-expect-error
self.browser ??= chrome;

document.addEventListener('DOMContentLoaded', async () => {
	const urlInput = /** @type {HTMLInputElement} */ (document.getElementById('youtube-url'));
	const form = /** @type {HTMLFormElement} */ (document.getElementById('url-form'));
	const pasteBtn = document.getElementById('paste-btn');
	const errorMsg = document.getElementById('error-message');
	const scoreDisplay = document.getElementById('current-score');
	const quickBtns = document.querySelectorAll('.quick-btn');

	// 1. Load and display current score from storage
	try {
		const data = await browser.storage.local.get('meme_score');
		const score = Number(data?.meme_score) || 0;
		if (scoreDisplay) {
			scoreDisplay.textContent = score.toString().padStart(6, '0');
		}
	} catch (e) {
		console.warn('Failed to load score:', e);
	}

	// 2. Quick link buttons
	quickBtns.forEach(btn => {
		btn.addEventListener('click', () => {
			const targetUrl = btn.getAttribute('data-url');
			if (targetUrl) {
				urlInput.value = targetUrl;
				if (errorMsg) errorMsg.hidden = true;
				urlInput.focus();
			}
		});
	});

	// 3. Paste from clipboard button
	pasteBtn?.addEventListener('click', async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text) {
				urlInput.value = text.trim();
				if (errorMsg) errorMsg.hidden = true;
			}
		} catch (err) {
			console.warn('Clipboard read failed, falling back to focus:', err);
			urlInput.focus();
		}
	});

	// 4. Validate YouTube URL
	function isValidYouTubeUrl(urlStr) {
		try {
			const url = new URL(urlStr);
			const hostname = url.hostname.toLowerCase();
			return (
				hostname === 'www.youtube.com' ||
				hostname === 'youtube.com' ||
				hostname === 'm.youtube.com' ||
				hostname === 'youtu.be'
			);
		} catch {
			return false;
		}
	}

	// Normalize URL (e.g. if user types without https://)
	function normalizeUrl(input) {
		let trimmed = input.trim();
		if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
			trimmed = 'https://' + trimmed;
		}
		return trimmed;
	}

	// 5. Handle Start submit
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const rawUrl = urlInput.value;
		const finalUrl = normalizeUrl(rawUrl);

		if (!isValidYouTubeUrl(finalUrl)) {
			if (errorMsg) {
				errorMsg.hidden = false;
			}
			urlInput.focus();
			return;
		}

		if (errorMsg) errorMsg.hidden = true;

		// Navigate to the YouTube page
		try {
			if (browser?.tabs) {
				// If running inside extension page, update current tab or open new tab
				const currentTab = await browser.tabs.getCurrent();
				if (currentTab && currentTab.id) {
					await browser.tabs.update(currentTab.id, { url: finalUrl });
				} else {
					await browser.tabs.create({ url: finalUrl });
				}
			} else {
				window.location.href = finalUrl;
			}
		} catch {
			window.location.href = finalUrl;
		}
	});
});
