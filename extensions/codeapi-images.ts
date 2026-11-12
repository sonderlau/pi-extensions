/**
 * CodeAPI (codeapi.icu) image generation: gpt-image-2 / 2.5-sunburst / 2.5-flare.
 * OpenAI Images protocol, same key as the codeapi chat provider.
 * Text-only input → POST /images/generations (JSON); input images → POST /images/edits (multipart).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://codeapi.icu/v1";
const API = "openai-images"; // custom api name; implementation supplied below

async function generateImages(model: any, context: any, options: any = {}) {
	const output: any = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		const apiKey: string = options.apiKey;
		if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const doFetch = options.fetch ?? fetch;
		const prompt = context.input
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");
		const images = context.input.filter((b: any) => b.type === "image");

		const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
		let body: BodyInit;
		if (images.length > 0) {
			const form = new FormData();
			form.append("model", model.id);
			form.append("prompt", prompt);
			for (const img of images) {
				const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
				form.append("image[]", new Blob([bytes], { type: img.mimeType }), "input.png");
			}
			body = form;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify({ model: model.id, prompt, size: "1024x1024", stream: false });
		}

		const res = await doFetch(`${model.baseUrl}/images/${images.length > 0 ? "edits" : "generations"}`, {
			method: "POST",
			headers,
			body,
			signal: options.signal,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`HTTP ${res.status} from ${model.provider}: ${text.slice(0, 500)}`);
		}
		const data = await res.json();
		if (data.usage?.total_tokens != null) {
			output.usage = {
				input: data.usage.input_tokens ?? 0,
				output: data.usage.output_tokens ?? 0,
				totalTokens: data.usage.total_tokens,
				cost: { total: 0 },
			};
		}
		for (const item of data.data ?? []) {
			if (item.b64_json) output.output.push({ type: "image", mimeType: "image/png", data: item.b64_json });
			else if (item.url) output.output.push({ type: "text", text: item.url });
		}
		if (output.output.length === 0) {
			throw new Error(`No images in response: ${JSON.stringify(data).slice(0, 300)}`);
		}
		return output;
	} catch (error) {
		output.stopReason = "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		return output;
	}
}

const IMAGE_MODEL = { type: "image", api: API, input: ["text", "image"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

export default function codeapiImages(pi: ExtensionAPI) {
	pi.registerProvider("codeapi-images", {
		name: "CodeAPI Images",
		baseUrl: BASE_URL,
		apiKey: "!cat /Users/sonderlau/.pi/agent/secrets/codeapi-key",
		models: [
			{ ...IMAGE_MODEL, id: "gpt-image-2", name: "GPT Image 2 (CodeAPI)" },
			{ ...IMAGE_MODEL, id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst (CodeAPI)" },
			{ ...IMAGE_MODEL, id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare (CodeAPI)" },
		],
		images: { [API]: { generateImages } },
	} as any);
}
