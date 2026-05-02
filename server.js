const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============= مفتاح السري =============
const JWT_SECRET = 'ayoub-ai-super-secret-key-2024';
let users = [];
let histories = {};
let nextId = 1;
let nextHistoryId = 1;

// ============= مفاتيح API المجانية (ضع مفاتيحك هنا) =============
const GEMINI_API_KEY = 'AIzaSyD5VtYqGqYxLjZVxZxZxZxZxZxZxZxZxZx'; // غيّره بمفتاحك
const GROQ_API_KEY = 'gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // غيّره بمفتاحك
const STABILITY_API_KEY = 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // غيّره بمفتاحك
const ELEVENLABS_API_KEY = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // غيّره بمفتاحك

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
        
        const apiKey = user?.apiKeys?.[model] || 
                      (model === 'gemini' ? GEMINI_API_KEY : GROQ_API_KEY);
        
        if (model === 'gemini') {
            const genAI = new GoogleGenerativeAI(apiKey);
            const modelAI = genAI.getGenerativeModel({ model: 'gemini-pro' });
            const response = await modelAI.generateContent(prompt);
            result = response.response.text();
        } else if (model === 'groq') {
            const groq = new Groq({ apiKey });
            const completion = await groq.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: 'mixtral-8x7b-32768',
            });
            result = completion.choices[0]?.message?.content || '';
        } else {
            result = 'النموذج غير مدعوم حالياً';
        }
        
        // حفظ في السجل
        histories[req.userId].unshift({
            id: nextHistoryId++,
            type: 'text',
            model,
            input: prompt.substring(0, 100),
            output: result.substring(0, 200),
            date: new Date()
        });
        
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: 'حدث خطأ: ' + error.message });
    }
});

app.post('/api/generate/image', authMiddleware, async (req, res) => {
    try {
        const { prompt } = req.body;
        
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
        
        histories[req.userId].unshift({
            id: nextHistoryId++,
            type: 'image',
            input: prompt.substring(0, 100),
            date: new Date()
        });
        
        res.json({ success: true, image: `data:image/png;base64,${imageBase64}` });
    } catch (error) {
        res.status(500).json({ error: 'فشل توليد الصورة: ' + error.message });
    }
});

app.post('/api/generate/tts', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        
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
        
        histories[req.userId].unshift({
            id: nextHistoryId++,
            type: 'audio',
            input: text.substring(0, 100),
            date: new Date()
        });
        
        res.json({ success: true, audio: `data:audio/mpeg;base64,${audioBase64}` });
    } catch (error) {
        res.status(500).json({ error: 'فشل تحويل النص إلى صوت: ' + error.message });
    }
});

app.post('/api/summarize', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        const result = await model.generateContent(`قم بتلخيص النص التالي بشكل احترافي باللغة العربية:\n\n${text}`);
        const summary = result.response.text();
        
        res.json({ success: true, summary });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/rewrite', authMiddleware, async (req, res) => {
    try {
        const { text } = req.body;
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        const result = await model.generateContent(`أعد كتابة النص التالي بشكل أكثر احترافية ووضوحاً مع الحفاظ على المعنى:\n\n${text}`);
        const rewritten = result.response.text();
        
        res.json({ success: true, rewritten });
    } catch (error) {
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

// ============= تشغيل الخادم =============
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`\n🚀 ==========================================`);
    console.log(`   ✨ Ayoub.Ai Backend Server ✨`);
    console.log(`   🖥️  Running on http://localhost:${PORT}`);
    console.log(`   📝 Ready to accept requests`);
    console.log(`==========================================\n`);
});