/**
 * ============================================================================
 *  WAKERA BACKEND  —  server.js
 *
 *  VIDEO STORAGE (picked automatically, first one configured wins):
 *      1. Bunny.net Storage + CDN   -> if BUNNY_* variables are set
 *      2. InterServer Storage VPS   -> if SFTP_* variables are set
 *      3. ImageKit (old behaviour)  -> if neither is set
 *
 *  THUMBNAILS : ImageKit (unchanged)
 *  DB / AUTH  : Firebase Admin (verifyIdToken)
 *
 *  You can deploy this file right now — nothing changes until you add
 *  variables in Render. Add Bunny's and it uses Bunny. Add the VPS ones
 *  instead and it uses the VPS. No code edits, no downtime.
 * ============================================================================
 */

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

/* ---------------------------------------------------------------------------
 * 1. FIREBASE ADMIN
 * ------------------------------------------------------------------------- */
try {
    admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || "wakera-b22df"
    });
    console.log("🛡️ Firebase Admin SDK initialized for token verification.");
} catch (e) {
    console.warn("⚠️ Firebase Admin initialization failed:", e.message);
}

/* ---------------------------------------------------------------------------
 * 2. AUTH MIDDLEWARE  (unchanged behaviour)
 * ------------------------------------------------------------------------- */
async function checkAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            req.user = await admin.auth().verifyIdToken(idToken);
        } catch (err) {
            console.warn('⚠️ Token decode warning (non-blocking):', err.message);
            req.user = { uid: 'anonymous_creator' };
        }
    } else {
        req.user = { uid: 'anonymous_creator' };
    }
    next();
}

/* ---------------------------------------------------------------------------
 * 3. CORS
 * ------------------------------------------------------------------------- */
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
        'https://wakera-b22df.web.app',
        'https://wakera-b22df.firebaseapp.com',
        'https://wakera.org',
        'https://www.wakera.org'
    ],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

/* ---------------------------------------------------------------------------
 * 4. UPLOAD PARSERS
 * ------------------------------------------------------------------------- */
const storage = multer.memoryStorage();

const uploadVideo = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('video/')) return cb(null, true);
        cb(new Error('Only video files are allowed.'));
    }
});

const uploadThumbnail = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
        cb(new Error('Only image files are allowed for thumbnails.'));
    }
});

/* ---------------------------------------------------------------------------
 * 5. IMAGEKIT  (thumbnails + legacy videos + legacy deletes)
 * ------------------------------------------------------------------------- */
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY;
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT;

function ensureImageKitConfigured(res) {
    if (!IMAGEKIT_PRIVATE_KEY) {
        res.status(500).json({
            success: false,
            error: 'ImageKit private key is not configured on the server.'
        });
        return false;
    }
    return true;
}

async function imageKitUpload(buffer, filename, contentType, folder, timeoutMs) {
    const form = new FormData();
    form.append('file', buffer, { filename, contentType });
    form.append('fileName', filename);
    form.append('folder', folder);
    form.append('useUniqueFileName', 'true');

    const response = await axios.post(
        'https://upload.imagekit.io/api/v1/files/upload',
        form,
        {
            auth: { username: IMAGEKIT_PRIVATE_KEY, password: '' },
            headers: { ...form.getHeaders() },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: timeoutMs
        }
    );

    return { url: response.data.url, fileId: response.data.fileId, name: response.data.name };
}

/* ---------------------------------------------------------------------------
 * 6a. BUNNY.NET STORAGE + CDN  (simplest option — no server to manage)
 *
 *   BUNNY_STORAGE_ZONE = wakera-media          (storage zone name)
 *   BUNNY_STORAGE_KEY  = the storage zone password
 *   BUNNY_STORAGE_HOST = ny.storage.bunnycdn.com   (region host, no https://)
 *   BUNNY_PULL_ZONE    = wakera-media.b-cdn.net    (or media.wakera.org)
 *   BUNNY_FOLDER       = videos                (optional, default "videos")
 * ------------------------------------------------------------------------- */
const BUNNY_STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const BUNNY_STORAGE_KEY = process.env.BUNNY_STORAGE_KEY;
const BUNNY_STORAGE_HOST = (process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com')
    .replace(/^https?:\/\//, '').replace(/\/+$/, '');
const BUNNY_PULL_ZONE = (process.env.BUNNY_PULL_ZONE || '')
    .replace(/^https?:\/\//, '').replace(/\/+$/, '');
const BUNNY_FOLDER = (process.env.BUNNY_FOLDER || 'videos').replace(/^\/+|\/+$/g, '');

const BUNNY_ENABLED = Boolean(BUNNY_STORAGE_ZONE && BUNNY_STORAGE_KEY && BUNNY_PULL_ZONE);

function bunnyUrl(filename) {
    return `https://${BUNNY_STORAGE_HOST}/${BUNNY_STORAGE_ZONE}/${BUNNY_FOLDER}/${filename}`;
}

async function bunnyPut(buffer, filename, contentType) {
    await axios.put(bunnyUrl(filename), buffer, {
        headers: {
            AccessKey: BUNNY_STORAGE_KEY,
            'Content-Type': contentType || 'application/octet-stream'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000
    });
    return `https://${BUNNY_PULL_ZONE}/${BUNNY_FOLDER}/${filename}`;
}

async function bunnyDelete(filename) {
    await axios.delete(bunnyUrl(filename), {
        headers: { AccessKey: BUNNY_STORAGE_KEY },
        timeout: 60000
    });
}

/* ---------------------------------------------------------------------------
 * 6b. INTERSERVER STORAGE VPS OVER SFTP
 * ------------------------------------------------------------------------- */
const SFTP_HOST = process.env.SFTP_HOST;
const SFTP_PORT = Number(process.env.SFTP_PORT || 22);
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PATH = (process.env.SFTP_PATH || '/var/www/media/videos').replace(/\/+$/, '');
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || '').replace(/\/+$/, '');

const VPS_ENABLED = Boolean(SFTP_HOST && SFTP_USER && MEDIA_BASE_URL && process.env.SFTP_PRIVATE_KEY);

let SftpClient = null;
function getSftpClient() {
    if (!SftpClient) SftpClient = require('ssh2-sftp-client');
    return SftpClient;
}

/** Accepts a normal PEM, a PEM with "\n" escapes, or a base64 blob. */
function getPrivateKey() {
    let key = process.env.SFTP_PRIVATE_KEY || '';
    if (!key.includes('BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(key)) {
        try { key = Buffer.from(key, 'base64').toString('utf8'); } catch (e) { /* keep as-is */ }
    }
    return key.replace(/\\n/g, '\n');
}

async function sftpConnect() {
    const Client = getSftpClient();
    const sftp = new Client();
    await sftp.connect({
        host: SFTP_HOST,
        port: SFTP_PORT,
        username: SFTP_USER,
        privateKey: getPrivateKey(),
        readyTimeout: 30000,
        keepaliveInterval: 10000
    });
    return sftp;
}

async function sftpPut(buffer, remoteFilename) {
    const sftp = await sftpConnect();
    try {
        await sftp.put(buffer, `${SFTP_PATH}/${remoteFilename}`);
    } finally {
        try { await sftp.end(); } catch (e) { /* ignore */ }
    }
    return `${MEDIA_BASE_URL}/${remoteFilename}`;
}

async function sftpDelete(remoteFilename) {
    const sftp = await sftpConnect();
    try {
        const target = `${SFTP_PATH}/${remoteFilename}`;
        if (await sftp.exists(target)) await sftp.delete(target);
    } finally {
        try { await sftp.end(); } catch (e) { /* ignore */ }
    }
}

/* ---------------------------------------------------------------------------
 * 7. HELPERS
 * ------------------------------------------------------------------------- */
/** Safe, unique, extension-preserving filename — no user text in the path. */
function buildFilename(originalName, prefix) {
    const ext = (path.extname(originalName || '').toLowerCase() || '.mp4')
        .replace(/[^.a-z0-9]/g, '')
        .slice(0, 6) || '.mp4';
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
}

const ACTIVE_VIDEO_STORAGE = BUNNY_ENABLED ? 'bunny' : (VPS_ENABLED ? 'vps' : 'imagekit');

/* ---------------------------------------------------------------------------
 * 8. HEALTH / DIAGNOSTICS
 * ------------------------------------------------------------------------- */
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Wakera secure backend is running!',
        timestamp: new Date().toISOString()
    });
});

// Open this after deploying to see what the server is using.
app.get('/storage-status', async (req, res) => {
    const report = {
        videoStorage: ACTIVE_VIDEO_STORAGE,
        thumbnails: 'imagekit',
        bunnyConfigured: BUNNY_ENABLED,
        sftpConfigured: VPS_ENABLED,
        imagekitPrivateKey: IMAGEKIT_PRIVATE_KEY ? 'configured' : 'missing'
    };

    if (BUNNY_ENABLED) {
        report.bunnyPullZone = BUNNY_PULL_ZONE;
        report.bunnyFolder = BUNNY_FOLDER;
    }
    if (VPS_ENABLED) {
        report.mediaBaseUrl = MEDIA_BASE_URL;
    }

    // ?test=1 makes a real connection test against Bunny
    if (BUNNY_ENABLED && req.query.test === '1') {
        try {
            await axios.put(bunnyUrl('_wakera_connection_test.txt'),
                Buffer.from('ok'), {
                    headers: { AccessKey: BUNNY_STORAGE_KEY, 'Content-Type': 'text/plain' },
                    timeout: 20000
                });
            await axios.delete(bunnyUrl('_wakera_connection_test.txt'), {
                headers: { AccessKey: BUNNY_STORAGE_KEY },
                timeout: 20000
            });
            report.bunnyConnection = 'ok';
        } catch (e) {
            report.bunnyConnection = 'failed';
            report.bunnyError = e.response?.status
                ? `HTTP ${e.response.status} — check the storage zone name and key`
                : e.message;
        }
    }

    // ?test=1 also tests SFTP when that is the active storage
    if (VPS_ENABLED && req.query.test === '1') {
        try {
            const sftp = await sftpConnect();
            report.sftpConnection = 'ok';
            report.remotePathExists = await sftp.exists(SFTP_PATH);
            await sftp.end();
        } catch (e) {
            report.sftpConnection = 'failed';
            report.sftpError = e.message;
        }
    }

    res.json(report);
});

/* ---------------------------------------------------------------------------
 * 9. VIDEO UPLOAD
 * ------------------------------------------------------------------------- */
app.post('/upload-video', checkAuth, uploadVideo.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No video file received.' });
        }

        const mb = (req.file.size / 1024 / 1024).toFixed(1);
        console.log(`📦 Video received: ${req.file.originalname} (${mb} MB) from ${req.user.uid}`);

        // ---- 1. Bunny.net ----
        if (BUNNY_ENABLED) {
            const filename = buildFilename(req.file.originalname, 'wakera');
            const url = await bunnyPut(req.file.buffer, filename, req.file.mimetype);
            console.log(`✅ Stored on Bunny: ${filename}`);
            return res.json({ success: true, url, fileId: `bunny:${filename}`, name: filename, storage: 'bunny' });
        }

        // ---- 2. Storage VPS over SFTP ----
        if (VPS_ENABLED) {
            const filename = buildFilename(req.file.originalname, 'wakera');
            const url = await sftpPut(req.file.buffer, filename);
            console.log(`✅ Stored on VPS: ${filename}`);
            return res.json({ success: true, url, fileId: `vps:${filename}`, name: filename, storage: 'vps' });
        }

        // ---- 3. ImageKit (original behaviour) ----
        if (!ensureImageKitConfigured(res)) return;

        const result = await imageKitUpload(
            req.file.buffer,
            `wakera_${Date.now()}_${req.file.originalname}`,
            req.file.mimetype,
            '/wakera-videos',
            300000
        );

        return res.json({ success: true, url: result.url, fileId: result.fileId, name: result.name, storage: 'imagekit' });
    } catch (error) {
        console.error('❌ Video upload error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Message || error.response?.data?.message || error.message || 'Video upload failed'
        });
    }
});

/* ---------------------------------------------------------------------------
 * 10. THUMBNAIL UPLOAD  (ImageKit — unchanged)
 * ------------------------------------------------------------------------- */
app.post('/upload-thumbnail', checkAuth, uploadThumbnail.single('thumbnail'), async (req, res) => {
    try {
        if (!ensureImageKitConfigured(res)) return;

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No thumbnail file received.' });
        }

        const originalName = req.file.originalname || 'thumbnail.jpg';
        const extension = originalName.includes('.') ? originalName.split('.').pop() : 'jpg';

        console.log(`🖼️ Thumbnail received: ${originalName} from ${req.user.uid}`);

        const result = await imageKitUpload(
            req.file.buffer,
            `thumb_${Date.now()}.${extension}`,
            req.file.mimetype || 'image/jpeg',
            '/wakera-thumbnails',
            120000
        );

        res.json({ success: true, url: result.url, fileId: result.fileId, name: result.name });
    } catch (error) {
        console.error('❌ Thumbnail upload error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Thumbnail upload failed'
        });
    }
});

/* ---------------------------------------------------------------------------
 * 11. DELETE
 *     "bunny:<name>" -> Bunny   |  "vps:<name>" -> VPS  |  else -> ImageKit
 * ------------------------------------------------------------------------- */
app.delete('/delete-video/:fileId', checkAuth, async (req, res) => {
    try {
        const { fileId } = req.params;

        if (!fileId) {
            return res.status(400).json({ success: false, error: 'No fileId provided.' });
        }

        console.log(`🗑️ Delete request: ${fileId} from ${req.user.uid}`);

        // Defence in depth: never allow a path escape.
        if (fileId.includes('/') || fileId.includes('..')) {
            return res.status(400).json({ success: false, error: 'Invalid file id.' });
        }

        if (fileId.startsWith('bunny:')) {
            if (!BUNNY_ENABLED) {
                return res.status(500).json({
                    success: false,
                    error: 'This video lives on Bunny but Bunny is not configured on the server.'
                });
            }
            await bunnyDelete(fileId.slice(6));
            return res.json({ success: true, storage: 'bunny' });
        }

        if (fileId.startsWith('vps:')) {
            if (!VPS_ENABLED) {
                return res.status(500).json({
                    success: false,
                    error: 'This video lives on the storage VPS but SFTP is not configured on the server.'
                });
            }
            await sftpDelete(fileId.slice(4));
            return res.json({ success: true, storage: 'vps' });
        }

        if (!ensureImageKitConfigured(res)) return;

        await axios.delete(`https://api.imagekit.io/v1/files/${fileId}`, {
            auth: { username: IMAGEKIT_PRIVATE_KEY, password: '' }
        });

        res.json({ success: true, storage: 'imagekit' });
    } catch (error) {
        console.error('❌ Delete error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.Message || error.response?.data?.message || error.message || 'Delete failed'
        });
    }
});

/* ---------------------------------------------------------------------------
 * 12. ERROR HANDLER
 * ------------------------------------------------------------------------- */
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err) {
        return res.status(400).json({ success: false, error: err.message || 'Server error' });
    }
    next();
});

/* ---------------------------------------------------------------------------
 * 13. BOOT
 * ------------------------------------------------------------------------- */
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Wakera backend running on port ${PORT}`);
    console.log(`Video storage   : ${ACTIVE_VIDEO_STORAGE.toUpperCase()}`);
    if (BUNNY_ENABLED) console.log(`   Pull zone    : ${BUNNY_PULL_ZONE}`);
    if (VPS_ENABLED && !BUNNY_ENABLED) {
        console.log(`   SFTP user    : ${SFTP_USER}@${SFTP_HOST}:${SFTP_PORT}`);
        console.log(`   Public base  : ${MEDIA_BASE_URL}`);
    }
    console.log(`Thumbnail storage: ImageKit`);
    console.log(`ImageKit keys    : private=${IMAGEKIT_PRIVATE_KEY ? 'YES' : 'NO'}`);
});
