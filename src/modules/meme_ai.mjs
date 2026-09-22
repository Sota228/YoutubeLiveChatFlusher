/**
 * @module meme_ai
 * @description Gemini API を使ってライブチャットのコメントに合ったミームを選択する
 */

const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
const REQUEST_TIMEOUT_MS = 3000;

/**
 * Gemini API を呼び出して、チャット内容に合ったミームIDを選択する。
 * @param {string[]} recentChats 直近のチャットテキスト（新しい順）
 * @param {Array<{ id: string; text: string }>} memes 有効なミーム一覧
 * @param {string} apiKey Gemini API キー
 * @returns {Promise<string | null>} 選ばれたミームID、または null（フォールバック指示）
 */
export async function selectMemeWithAI(recentChats, memes, apiKey) {
	if (!apiKey || !recentChats.length || !memes.length) return null;

	const chatBlock = recentChats
		.slice(0, 20)
		.map((t, i) => `${i + 1}. ${t}`)
		.join('\n');

	const memeList = memes
		.map(m => `- ${m.id}: ${m.text}`)
		.join('\n');

	const prompt = `You are a meme selector for a Japanese YouTube live chat viewer.
Given the recent chat messages and a list of memes (id: text), respond with ONLY the single meme ID that best fits the mood or content of the recent chat. Do not explain. Output only the ID string.

Recent chat messages (newest first):
${chatBlock}

Available memes (id: text):
${memeList}`;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		const res = await fetch(GEMINI_API_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey,
			},
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					maxOutputTokens: 20,
				},
			}),
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!res.ok) {
			console.warn(`[MEME-AI] Gemini API error: ${res.status} ${res.statusText}`);
			return null;
		}

		const json = await res.json();
		const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';

		// Extract the meme ID from the response (e.g. "preset_09")
		const match = rawText.match(/preset_\d+/);
		const selectedId = match?.[0] ?? rawText;

		// Validate that the ID actually exists in our list
		const found = memes.find(m => m.id === selectedId);
		if (!found) {
			console.warn(`[MEME-AI] AI returned unknown meme ID: "${rawText}", falling back.`);
			return null;
		}

		console.info(`[MEME-AI] Selected: ${found.id} (${found.text})`);
		return found.id;
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			console.warn('[MEME-AI] Request timed out, falling back to random.');
		} else {
			console.warn('[MEME-AI] Error calling Gemini API:', err);
		}
		return null;
	}
}
