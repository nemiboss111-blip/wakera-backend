// ============================================================
// WAKERA BACKEND SERVER
// Handles video uploads to ImageKit
// Run with: node server.js
// ============================================================

const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const FormData = require('form-data');
const cors    = require('cors');
require('dotenv').config();

const app = express();

// ── Allow requests from your website ──
app.use(cors({
    // In production, change this to your Firebase Hosting URL
    origin: ['http://localhost:3000', 'https://wakera-b22df.web.app'],
    methods: ['GET', 'POST', 'DELETE']
}));

// ── Store file in memory (not on disk) ──
const storage = multer.memoryStorage();
const upload  = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB max
    fileFilter: (req, file, cb) => {
        // Only allow video files
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed!'), false);
        }
    }
});

// ── ImageKit Credentials ──
// Put these in a .env file - never hardcode secrets!
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY;
const IMAGEKIT_PUBLIC_KEY  = process.env.IMAGEKIT_PUBLIC_KEY;
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT;

// ── Health Check ──
app.get('/', (req, res) => {
    res.json({ status: 'Wakera backend is running!' });
});

// ── Upload Video Route ──
app.post('/upload-video', upload.single('video'), async (req, res) => {
    try {
        // Make sure a file was sent
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No video file received.'
            });
        }

        console.log(`📦 Received file: ${req.file.originalname} 
                     (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

        // ── Build the form to send to ImageKit ──
        const form = new FormData();
        form.append('file', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype,
        });
        // Unique filename using timestamp
        form.append('fileName', `wakera_${Date.now()}_${req.file.originalname}`);
        form.append('folder', '/wakera-videos');
        form.append('useUniqueFileName', 'true');

        // ── Send to ImageKit ──
        const ikResponse = await axios.post(
            'https://upload.imagekit.io/api/v1/files/upload',
            form,
            {
                auth: {
                    username: IMAGEKIT_PRIVATE_KEY,
                    password: ''
                },
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                // Track upload progress in console
                onUploadProgress: (progressEvent) => {
                    const pct = Math.round(
                        (progressEvent.loaded * 100) / progressEvent.total
                    );
                    process.stdout.write(`\r⬆️  Uploading to ImageKit: ${pct}%`);
                }
            }
        );

        console.log('\n✅ Upload to ImageKit complete!');
        console.log('🔗 URL:', ikResponse.data.url);

        // ── Send success back to the website ──
        res.json({
            success: true,
            url: ikResponse.data.url,
            fileId: ikResponse.data.fileId,
            name: ikResponse.data.name
        });

    } catch (error) {
        console.error('❌ Upload error:', error.message);
        
        // Give the website a useful error message
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message || 'Upload failed'
        });
    }
});

// ── Delete Video Route ──
app.delete('/delete-video/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;

        await axios.delete(
            `https://api.imagekit.io/v1/files/${fileId}`,
            {
                auth: {
                    username: IMAGEKIT_PRIVATE_KEY,
                    password: ''
                }
            }
        );

        console.log(`🗑️ Deleted file: ${fileId}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Delete error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ── Start Server ──
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════╗
║   🎬 Wakera Backend Running        ║
║   Port: ${PORT}                       ║
║   http://localhost:${PORT}            ║
╚════════════════════════════════════╝
    `);
});