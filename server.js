const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// Initialize Firebase Admin SDK cleanly for Signature Verification (Render-friendly!)
try {
    admin.initializeApp({
        projectId: "wakera-b22df"
    });
    console.log("🛡️ Firebase Admin SDK initialized successfully for public token verification.");
} catch (e) {
    console.warn("⚠️ Firebase Admin initialization failed:", e.message);
}

// Middleware to verify Firebase JWT Auth Token before allowing uploads
async function checkAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Access denied. Please log in first.'
        });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // Add decoded user details to request object
        next();
    } catch (err) {
        console.error('❌ Token Verification Error:', err.message);
        return res.status(403).json({
            success: false,
            error: 'Unauthorized: Invalid or expired authentication session.'
        });
    }
}

// Allow CORS Requests from Localhost and all Wakera Domains
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

const storage = multer.memoryStorage();

const uploadVideo = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed.'));
        }
    }
});

const uploadThumbnail = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed for thumbnails.'));
        }
    }
});

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

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Wakera secure backend is running!',
        timestamp: new Date().toISOString()
    });
});

// Protect Video Uploads with checkAuth Middleware
app.post('/upload-video', checkAuth, uploadVideo.single('video'), async (req, res) => {
    try {
        if (!ensureImageKitConfigured(res)) return;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No video file received.'
            });
        }

        console.log(`📦 Received video: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB) from User: ${req.user.uid}`);

        const form = new FormData();
        form.append('file', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });
        form.append('fileName', `wakera_${Date.now()}_${req.file.originalname}`);
        form.append('folder', '/wakera-videos');
        form.append('useUniqueFileName', 'true');

        const ikResponse = await axios.post(
            'https://upload.imagekit.io/api/v1/files/upload',
            form,
            {
                auth: {
                    username: IMAGEKIT_PRIVATE_KEY,
                    password: ''
                },
                headers: { ...form.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 300000
            }
        );

        res.json({
            success: true,
            url: ikResponse.data.url,
            fileId: ikResponse.data.fileId,
            name: ikResponse.data.name
        });
    } catch (error) {
        console.error('❌ Video upload error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Video upload failed'
        });
    }
});

// Protect Thumbnail Uploads with checkAuth Middleware
app.post('/upload-thumbnail', checkAuth, uploadThumbnail.single('thumbnail'), async (req, res) => {
    try {
        if (!ensureImageKitConfigured(res)) return;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No thumbnail file received.'
            });
        }

        const originalName = req.file.originalname || 'thumbnail.jpg';
        const extension = originalName.includes('.') ? originalName.split('.').pop() : 'jpg';

        console.log(`🖼️ Received thumbnail: ${originalName} from User: ${req.user.uid}`);

        const form = new FormData();
        form.append('file', req.file.buffer, {
            filename: originalName,
            contentType: req.file.mimetype || 'image/jpeg'
        });
        form.append('fileName', `thumb_${Date.now()}.${extension}`);
        form.append('folder', '/wakera-thumbnails');
        form.append('useUniqueFileName', 'true');

        const ikResponse = await axios.post(
            'https://upload.imagekit.io/api/v1/files/upload',
            form,
            {
                auth: {
                    username: IMAGEKIT_PRIVATE_KEY,
                    password: ''
                },
                headers: { ...form.getHeaders() },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 120000
            }
        );

        res.json({
            success: true,
            url: ikResponse.data.url,
            fileId: ikResponse.data.fileId,
            name: ikResponse.data.name
        });
    } catch (error) {
        console.error('❌ Thumbnail upload error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Thumbnail upload failed'
        });
    }
});

// Protect Delete Video Endpoints with checkAuth Middleware
app.delete('/delete-video/:fileId', checkAuth, async (req, res) => {
    try {
        if (!ensureImageKitConfigured(res)) return;

        const { fileId } = req.params;

        if (!fileId) {
            return res.status(400).json({
                success: false,
                error: 'No fileId provided.'
            });
        }

        console.log(`🗑️ Processing delete request for fileId: ${fileId} from User: ${req.user.uid}`);

        await axios.delete(`https://api.imagekit.io/v1/files/${fileId}`, {
            auth: {
                username: IMAGEKIT_PRIVATE_KEY,
                password: ''
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Delete error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Delete failed'
        });
    }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }

    if (err) {
        return res.status(400).json({
            success: false,
            error: err.message || 'Server error'
        });
    }

    next();
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Wakera secure backend running on port ${PORT}`);
    console.log(`ImageKit private key configured: ${IMAGEKIT_PRIVATE_KEY ? 'YES' : 'NO'}`);
    console.log(`ImageKit public key configured: ${IMAGEKIT_PUBLIC_KEY ? 'YES' : 'NO'}`);
    console.log(`ImageKit URL endpoint configured: ${IMAGEKIT_URL_ENDPOINT ? 'YES' : 'NO'}`);
});