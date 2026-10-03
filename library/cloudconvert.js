// CloudConvert helper: converts a .webp (animated) into an .mp4 using the CloudConvert v2 API.
// Needs CLOUDCONVERT_API_KEY in .env (create one at https://cloudconvert.com/dashboard/api/v2/keys
// with the scopes "task.read" and "task.write").

const axios = require('axios');
const FormData = require('form-data');

const API = process.env.CLOUDCONVERT_API_BASE || 'https://api.cloudconvert.com/v2';
const POLL_MS = 2000;
const TIMEOUT_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// true if the WebP file is animated (VP8X header with the animation flag set)
const isAnimatedWebp = (buf) =>
    Buffer.isBuffer(buf) && buf.length > 21 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP' &&
    buf.toString('ascii', 12, 16) === 'VP8X' &&
    (buf[20] & 0x02) === 0x02;

const errText = (e) => {
    const d = e?.response?.data;
    return (d && (d.message || d.error)) ? `${e.response.status}: ${d.message || d.error}` : (e.message || String(e));
};

async function webpToMp4(buffer, { apiKey = process.env.CLOUDCONVERT_API_KEY, timeoutMs = TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('CLOUDCONVERT_API_KEY is missing in .env');
    const auth = { Authorization: `Bearer ${apiKey}` };

    try {
        // 1. create the job: upload -> convert -> export
        const { data: created } = await axios.post(`${API}/jobs`, {
            tasks: {
                'import-file': { operation: 'import/upload' },
                'convert-file': {
                    operation: 'convert',
                    input: 'import-file',
                    input_format: 'webp',
                    output_format: 'mp4'
                },
                'export-file': { operation: 'export/url', input: 'convert-file' }
            },
            tag: 'wa-bot-webp-to-mp4'
        }, { headers: auth });

        const job = created.data;
        const uploadTask = job.tasks.find((t) => t.name === 'import-file');
        const form = uploadTask?.result?.form;
        if (!form) throw new Error('CloudConvert did not return an upload URL');

        // 2. upload the webp (the file field must come last)
        const fd = new FormData();
        for (const [k, v] of Object.entries(form.parameters || {})) fd.append(k, v);
        fd.append('file', buffer, { filename: 'input.webp', contentType: 'image/webp' });
        await axios.post(form.url, fd, {
            headers: fd.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        // 3. wait for the job to finish
        const start = Date.now();
        let current = job;
        while (current.status !== 'finished') {
            if (current.status === 'error') {
                const failed = current.tasks.find((t) => t.status === 'error');
                throw new Error(failed?.message || 'CloudConvert job failed');
            }
            if (Date.now() - start > timeoutMs) throw new Error('CloudConvert timed out');
            await sleep(POLL_MS);
            current = (await axios.get(`${API}/jobs/${job.id}`, { headers: auth })).data.data;
        }

        // 4. download the mp4
        const file = current.tasks.find((t) => t.name === 'export-file')?.result?.files?.[0];
        if (!file?.url) throw new Error('CloudConvert finished but returned no file');
        const res = await axios.get(file.url, { responseType: 'arraybuffer', maxContentLength: Infinity });
        return Buffer.from(res.data);
    } catch (e) {
        throw new Error('CloudConvert: ' + errText(e));
    }
}

module.exports = { webpToMp4, isAnimatedWebp };
