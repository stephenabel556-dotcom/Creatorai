// All third-party AI calls live here. Swap a provider by editing only this file.
const E = process.env;
const RH = () => ({ Authorization: `Bearer ${E.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' });
const TONES = ['Funny', 'Romantic', 'Professional', 'Motivational', 'Casual'];

// Image + video via Replicate. Input field names differ per model: check your model's page on replicate.com.
export async function startJob(kind, prompt, image, seconds = 5) {
  if (!E.REPLICATE_API_TOKEN) throw new Error('REPLICATE_API_TOKEN not set');
  const video = kind === 'video';
  const model = video ? (E.REPLICATE_VIDEO_MODEL || 'bytedance/seedance-1-lite') : (E.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-kontext-pro');
  const input = video ? { prompt, image, duration: seconds } : { prompt, input_image: image, output_format: 'png' };
  const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, { method: 'POST', headers: RH(), body: JSON.stringify({ input }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.detail || 'Provider rejected the request');
  return j.id;
}
export async function checkJob(id) {
  const j = await (await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: RH() })).json();
  if (j.status === 'succeeded') return { status: 'succeeded', url: Array.isArray(j.output) ? j.output[0] : j.output };
  if (j.status === 'failed' || j.status === 'canceled') return { status: 'failed', error: j.error };
  return { status: 'processing' };
}

// Captions via the Anthropic API.
export async function makeCaptions(desc, tone) {
  if (!E.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!TONES.includes(tone)) tone = 'Casual';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: E.CAPTION_MODEL || 'claude-sonnet-5-5', max_tokens: 700,
      system: 'You write social media captions. Return exactly 5 captions, one per line, no numbering or extra text. End each with 2-3 relevant hashtags.',
      messages: [{ role: 'user', content: `Tone: ${tone}\nPost description: ${desc}` }] }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Caption provider error');
  return j.content.map(c => c.text || '').join('').trim();
}
