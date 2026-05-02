const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();

// ============= إعدادات middleware =============
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

// ============= مفتاح السري =============
const JWT_SECRET = process.env.JWT_SECRET || 'ayoub-ai-super-secret-key-2024';

// ============= مفاتيح API من متغيرات البيئة =============
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const STABILITY_API_KEY = process.env.STABILITY_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// ============= تخزين مؤقت =============
let users = [];
let histories = {};
let nextId = 1;
let nextHistoryId = 1;

// ============= دوال المساعدة =============
function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'توكن غير صالح' });
    
    req.userId = decoded.userId;
    next();
}

// ============= دالة Groq باستخدام OpenAI SDK =============
async function callGroq(apiKey, prompt) {
    const groq = new OpenAI({
        apiKey: apiKey,
        baseURL: 'https://api.groq.com/openai/v1'
    });
    
    const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'mixtral-8x7b-32768',
    });
    
    return completion.choices[0]?.message?.content || '';
}

// ============= Routes المصادقة =============
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (users.find(u => u.email === email)) {
            return res.status(400).json({ error: 'البريد الإلكتروني مسجل مسبقاً' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = { 
            id: nextId++, 
            name, 
            email, 
            password: hashedPassword, 
            apiKeys: {},
            createdAt: new Date()
        };
        users.push(user);
        histories[user.id] = [];
        
        res.json({ 
            token: generateToken(user.id), 
            user: { id: user.id, name, email } 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = users.find(u => u.email === email);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'البريد أو كلمة المرور غير صحيحة' });
        }
        res.json({ 
            token: generateToken(user.id), 
            user: { id: user.id, name: user.name, email: user.email } 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/me', authMiddleware, (req, res) => {
    const user = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
    res.json({ 
        id: user.id, 
        name: user.name, 
        email: user.email, 
        apiKeys: user.apiKeys 
    });
});

app.put('/api/keys', authMiddleware, (req, res) => {
    const user = users.find(u => u.id === req.userId);
    if (user) {
        user.apiKeys = { ...user.apiKeys, ...req.body };
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'مستخدم غير موجود' });
    }
});

// ============= Routes الذكاء الاصطناعي =============
app.post('/api/generate/text', authMiddleware, async (req, res) => {
    try {
        const { model, prompt } = req.body;
        const user = users.find(u => u.id === req.userId);
        let result = '';
        
        if (model === 'gemini') {
            const apiKey = user?.apiKeys?.gemini || GEMINI_API_KEY;
            if (!apiKey) {
                return res.status(400).json({ error: 'مفتاح Gemini غير متوفر. يرجى إضافته في الإعدادات' });
            }
            const genAI = new GoogleGenerativeAI(apiKey);
            const modelAI = genAI.getGenerativeModel({ model: 'gemini-pro' });
            const response = await modelAI.generateContent(prompt);
            result = response.response.text();
        } else if (model === 'groq') {
            const apiKey = user?.apiKeys?.groq || GROQ_API_KEY;
            if (!apiKey) {
                return res.status(400).json({ error: 'مفتاح Groq غير متوفر. يرجى إضافته في الإعدادات' });
            }
            result = await callGroq(apiKey, prompt);
        } else {
            result = 'النموذج غير مدعوم حالياً';
        }
        
        if (histories[req.userId]) {
            histories[req.userId].unshift({
                id: nextHistoryId++,
                type: 'text',
                model,
                input: prompt.substring(0, 100),
                output: result.substring(0, 200),
                date: new Date()
            });
        }
        
        res.json({ success: true, result });
    } catch (error) {
        console.error('Text generation error:', error);
        res.status(500).json({ error: 'حدث خطأ: ' + error.message });
    }
});

app.post('/api/generate/image', authMiddleware, async (req, res) => {
    try {
        const { prompt } = req.body;
        
        if (!STABILITY_API_KEY) {
            return res.status(400).json({ error: 'مفتاح Stability AI غير متوفر' });
        }
        
        const response = await axios.post(
            'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
            {
                text_prompts: [{ text: prompt, weight: 1 }],
                cfg_scale: 7,
                height: 512,
                width: 512,
                samples: 1,
                steps: 30,
            },
            { 
                headers: { 
                    'Authorization': `Bearer ${STABILITY_API_KEY}`, 
                    'Content-Type': 'application/json' 
                } 
            }
        );
        
        const imageBase64 = response.data.artifacts[0].base64;
        
        if (histories[req.userId]) {
            histories[req.userId].unshift({
                id: nextHistoryId++,
                type: 'image',
                input: prompt.substring(0, 100),
                date: new Date()
            });
        }
        
        res.json({ success: true, image: `data:image/png;base64,${imageBase64}` });
    } catch (error) {
        console.error('Image generation error:', error);
        res.status(500).json({ error: 'فشل توليد الصورة: ' + error.message });
    }
});

app.post('/api/generate/tts', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!ELEVENLABS_API_KEY) {
            return res.status(400).json({ error: 'مفتاح ElevenLabs غير متوفر' });
        }
        
        const response = await axios.post(
            'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM',
            { 
                text, 
                model_id: 'eleven_monolingual_v1',
                voice_settings: { stability: 0.5, similarity_boost: 0.5 }
            },
            { 
                headers: { 
                    'xi-api-key': ELEVENLABS_API_KEY, 
                    'Content-Type': 'application/json' 
                }, 
                responseType: 'arraybuffer' 
            }
        );
        
        const audioBase64 = Buffer.from(response.data).toString('base64');
        
        if (histories[req.userId]) {
            histories[req.userId].unshift({
                id: nextHistoryId++,
                type: 'audio',
                input: text.substring(0, 100),
                date: new Date()
            });
        }
        
        res.json({ success: true, audio: `data:audio/mpeg;base64,${audioBase64}` });
    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({ error: 'فشل تحويل النص إلى صوت: ' + error.message });
    }
});

app.post('/api/summarize', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!GEMINI_API_KEY) {
            return res.status(400).json({ error: 'مفتاح Gemini غير متوفر' });
        }
        
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        const result = await model.generateContent(`قم بتلخيص النص التالي بشكل احترافي باللغة العربية:\n\n${text}`);
        const summary = result.response.text();
        
        res.json({ success: true, summary });
    } catch (error) {
        console.error('Summarize error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/rewrite', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!GEMINI_API_KEY) {
            return res.status(400).json({ error: 'مفتاح Gemini غير متوفر' });
        }
        
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        const result = await model.generateContent(`أعد كتابة النص التالي بشكل أكثر احترافية ووضوحاً مع الحفاظ على المعنى:\n\n${text}`);
        const rewritten = result.response.text();
        
        res.json({ success: true, rewritten });
    } catch (error) {
        console.error('Rewrite error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/history', authMiddleware, (req, res) => {
    res.json({ history: histories[req.userId] || [] });
});

app.get('/api/stats', authMiddleware, (req, res) => {
    const userHistory = histories[req.userId] || [];
    const today = new Date().toDateString();
    const todayCount = userHistory.filter(h => new Date(h.date).toDateString() === today).length;
    
    res.json({
        total: userHistory.length,
        today: todayCount
    });
});

// ============= خدمة الواجهة الأمامية =============
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ============= تشغيل الخادم =============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n🚀 ==========================================`);
    console.log(`   ✨ Ayoub.Ai Backend Server ✨`);
    console.log(`   🖥️  Running on http://localhost:${PORT}`);
    console.log(`   📝 Ready to accept requests`);
    console.log(`==========================================\n`);
});