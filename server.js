// ============================================================
// WAKERA BACKEND SERVER
// Deployed on Render.com
// ============================================================

const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const cors     = require('cors');

const app = express();

// ── CORS - Allow your Firebase website to talk to this server ──
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://localhost:5500',       // VS Code Live Server
        'http://127.0.0.1:5500',
        'https://wakera-b22df.web.app',        // Your Firebase site
        'https://wakera-b22df.firebaseapp.com' // Firebase alternate URL
    ],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

// ── File upload config - store in memory ──
const storage = multer.memoryStorage();
const upload  = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed!'), false);
        }
    }
});

// ── Read ImageKit credentials from environment variables ──
// On Render, you set these in the dashboard (not in .env file)
const IMAGEKIT_PRIVATE_KEY  = process.env.IMAGEKIT_PRIVATE_KEY;
const IMAGEKIT_PUBLIC_KEY   = process.env.IMAGEKIT_PUBLIC_KEY;
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT;

// ============================================================
// ROUTES
// ============================================================

// ── Health Check - Render uses this to know server is alive ──
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Wakera backend is running!',
        timestamp: new Date().toISOString()
    });
});

// ── Upload Video ──
app.post('/upload-video', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No video file received.'
            });
        }

        // Check that ImageKit credentials are set
        if (!IMAGEKIT_PRIVATE_KEY) {
            return res.status(500).json({
                success: false,
                error: 'ImageKit credentials not configured on server.'
            });
        }

        console.log(`📦 Received: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

        // Build form to send to ImageKit
        const form = new FormData();
        form.append('file', req.file.buffer, {
            filename:    req.file.originalname,
            contentType: req.file.mimetype,
        });
        form.append('fileName',        `wakera_${Date.now()}_${req.file.originalname}`);
        form.append('folder',          '/wakera-videos');
        form.append('useUniqueFileName', 'true');

        // Send to ImageKit
        console.log('⬆️  Sending to ImageKit...');
        const ikResponse = await axios.post(
            'https://upload.imagekit.io/api/v1/files/upload',
            form,
            {
                auth: {
                    username: IMAGEKIT_PRIVATE_KEY,
                    password: ''
                },
                headers: {
                    ...form.getHeaders()
                },
                maxContentLength: Infinity,
                maxBodyLength:    Infinity,
                timeout: 300000 // 5 minute timeout for large files
            }
        );

        console.log('✅ ImageKit upload complete:', ikResponse.data.url);

        res.json({
            success: true,
            url:     ikResponse.data.url,
            fileId:  ikResponse.data.fileId,
            name:    ikResponse.data.name
        });

    } catch (error) {
        console.error('❌ Upload error:', error.message);

        // Send specific error info back
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Upload failed'
        });
    }
});

// ── Upload Thumbnail Image ──
app.post('/upload-thumbnail', upload.single('thumbnail'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No thumbnail file received.'
            });
        }

        console.log(`🖼️ Thumbnail received: ${req.file.originalname}`);

        const form = new FormData();
        form.append('file', req.file.buffer, {
            filename:    req.file.originalname || 'thumbnail.jpg',
            contentType: req.file.mimetype || 'image/jpeg',
        });
        form.append('fileName',  `thumb_${Date.now()}.jpg`);
        form.append('folder',    '/wakera-thumbnails');
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
                maxBodyLength:    Infinity,
            }
        );

        console.log('✅ Thumbnail uploaded:', ikResponse.data.url);

        res.json({
            success: true,
            url:     ikResponse.data.url,
            fileId:  ikResponse.data.fileId
        });

    } catch (error) {
        console.error('❌ Thumbnail upload error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ── Delete Video ──
app.delete('/delete-video/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

        if (!fileId) {
            return res.status(400).json({
                success: false,
                error: 'No fileId provided'
            });
        }

        console.log(`🗑️  Deleting file: ${fileId}`);

        await axios.delete(
            `https://api.imagekit.io/v1/files/${fileId}`,
            {
                auth: {
                    username: IMAGEKIT_PRIVATE_KEY,
                    password: ''
                }
            }
        );

        console.log('✅ File deleted from ImageKit');
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Delete error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================
// START SERVER
// ============================================================

// Render gives us the PORT automatically via environment variable
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🎬 Wakera Backend Running            ║
║   Port     : ${PORT}                      ║
║   ImageKit : ${IMAGEKIT_PRIVATE_KEY ? '✅ Configured' : '❌ NOT SET'}          ║
╚════════════════════════════════════════╝
    `);
});