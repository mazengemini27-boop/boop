/**
 * ============================================================================
 * المثبت التلقائي الشامل (One-Command Full Backend Installer)
 * ============================================================================
 * كيفية الاستخدام:
 * 1. احفظ هذا الملف باسم install_all.js داخل مجلد math-platform (بجوار مجلد public).
 * 2. افتح شاشة الأوامر (CMD أو PowerShell) داخل المجلد واكتب هذا الأمر الواحد فقط:
 *    node install_all.js && npm install && npm run seed && npm start
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

console.log('====================================================');
console.log('⏳ جاري إنشاء جميع ملفات المنصة تلقائياً...');
console.log('====================================================\n');

// 1. إنشاء package.json
const pkg = {
  name: 'educational-compendium-math',
  version: '1.0.0',
  description: 'المنصة التعليمية المتكاملة لمنهج الرياضيات للمرحلة الإعدادية المصرية',
  main: 'server.js',
  scripts: {
    start: 'node server.js',
    seed: 'node seed.js'
  },
  dependencies: {
    '@google/genai': '^0.1.2',
    'better-sqlite3': '^11.3.0',
    cors: '^2.8.5',
    dotenv: '^16.4.5',
    express: '^4.21.0',
    multer: '^1.4.5-lts.1'
  }
};
fs.writeFileSync(path.join(__dirname, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
console.log('✅ [1/4] تم إنشاء ملف package.json');

// 2. إنشاء ملف البيئة .env
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, 'PORT=3000\nGEMINI_API_KEY=\nADMIN_PASSCODE=123456\n', 'utf8');
  console.log('✅ [2/4] تم إنشاء ملف .env');
} else {
  console.log('✅ [2/4] ملف .env موجود بالفعل');
}

// 3. إنشاء ملف قاعدة البيانات db.js
const dbCode = `const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'compendium.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(\`
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grade INTEGER NOT NULL CHECK(grade IN (1, 2, 3)),
      term INTEGER NOT NULL DEFAULT 1 CHECK(term IN (1, 2)),
      branch TEXT NOT NULL DEFAULT 'algebra',
      order_num INTEGER NOT NULL DEFAULT 1,
      title_ar TEXT NOT NULL,
      title_en TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id INTEGER NOT NULL,
      order_num INTEGER NOT NULL DEFAULT 1,
      title_ar TEXT NOT NULL,
      title_en TEXT NOT NULL,
      video_url_ar TEXT DEFAULT '',
      video_url_en TEXT DEFAULT '',
      explain_ar TEXT NOT NULL,
      explain_en TEXT NOT NULL,
      examples_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER NOT NULL,
      question_ar TEXT NOT NULL,
      question_en TEXT NOT NULL,
      options_ar_json TEXT NOT NULL,
      options_en_json TEXT NOT NULL,
      correct_index INTEGER NOT NULL,
      explanation_ar TEXT NOT NULL,
      explanation_en TEXT NOT NULL,
      concept_tag TEXT DEFAULT 'عام',
      difficulty TEXT DEFAULT 'medium',
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      grade INTEGER NOT NULL DEFAULT 1,
      track TEXT NOT NULL DEFAULT 'ar',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS student_progress (
      student_id INTEGER NOT NULL,
      lesson_id INTEGER NOT NULL,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (student_id, lesson_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      lesson_id INTEGER,
      grade INTEGER NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      percentage INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS student_mistakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      lesson_id INTEGER,
      question_text TEXT NOT NULL,
      chosen_answer TEXT NOT NULL,
      correct_answer TEXT NOT NULL,
      concept_tag TEXT DEFAULT 'عام',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );
  \`);

  const defaultStudent = db.prepare('SELECT * FROM students WHERE code = ?').get('STD-1001');
  if (!defaultStudent) {
    db.prepare('INSERT INTO students (code, name, grade, track) VALUES (?, ?, ?, ?)').run(
      'STD-1001',
      'طالب المرحلة الإعدادية',
      1,
      'ar'
    );
  }
}

initDB();
module.exports = db;
`;
fs.writeFileSync(path.join(__dirname, 'db.js'), dbCode, 'utf8');
console.log('✅ [3/4] تم إنشاء ملف قاعدة البيانات db.js');

// 4. إنشاء ملف الخادم server.js
const serverCode = `require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

app.get('/api/curriculum', (req, res) => {
  try {
    const grade = parseInt(req.query.grade) || 1;
    const term = parseInt(req.query.term) || 1;
    const units = db.prepare('SELECT * FROM units WHERE grade = ? AND term = ? ORDER BY order_num ASC, id ASC').all(grade, term);
    const getLessons = db.prepare('SELECT * FROM lessons WHERE unit_id = ? ORDER BY order_num ASC, id ASC');
    const result = units.map((u) => ({
      ...u,
      lessons: getLessons.all(u.id).map((l) => ({ ...l, examples: JSON.parse(l.examples_json || '[]') }))
    }));
    res.json({ grade, term, units: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quiz', (req, res) => {
  try {
    const { lesson_id, grade } = req.query;
    let rows = [];
    if (lesson_id) {
      rows = db.prepare('SELECT * FROM questions WHERE lesson_id = ?').all(lesson_id);
    } else if (grade) {
      rows = db.prepare('SELECT q.* FROM questions q JOIN lessons l ON q.lesson_id = l.id JOIN units u ON l.unit_id = u.id WHERE u.grade = ? ORDER BY RANDOM() LIMIT 15').all(grade);
    }
    const questions = rows.map((q) => ({
      ...q,
      options_ar: JSON.parse(q.options_ar_json || '[]'),
      options_en: JSON.parse(q.options_en_json || '[]')
    }));
    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/student/:code', (req, res) => {
  try {
    let student = db.prepare('SELECT * FROM students WHERE code = ?').get(req.params.code);
    if (!student) {
      const info = db.prepare('INSERT INTO students (code, name, grade, track) VALUES (?, ?, 1, "ar")').run(req.params.code, 'طالب (' + req.params.code + ')');
      student = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    }
    const completedLessons = db.prepare('SELECT lesson_id FROM student_progress WHERE student_id = ?').all(student.id);
    const attempts = db.prepare('SELECT * FROM quiz_attempts WHERE student_id = ? ORDER BY created_at DESC LIMIT 20').all(student.id);
    const mistakes = db.prepare('SELECT * FROM student_mistakes WHERE student_id = ? ORDER BY created_at DESC LIMIT 30').all(student.id);
    res.json({ student, completedLessonIds: completedLessons.map((c) => c.lesson_id), attempts, mistakes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/student/complete-lesson', (req, res) => {
  try {
    const { student_code, lesson_id } = req.body;
    const student = db.prepare('SELECT * FROM students WHERE code = ?').get(student_code);
    if (student) {
      db.prepare('INSERT OR IGNORE INTO student_progress (student_id, lesson_id) VALUES (?, ?)').run(student.id, lesson_id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/student/submit-quiz', (req, res) => {
  try {
    const { student_code, lesson_id, grade, score, total, mistakes } = req.body;
    const student = db.prepare('SELECT * FROM students WHERE code = ?').get(student_code);
    if (!student) return res.status(404).json({ error: 'Not found' });
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    db.prepare('INSERT INTO quiz_attempts (student_id, lesson_id, grade, score, total, percentage) VALUES (?, ?, ?, ?, ?, ?)').run(student.id, lesson_id || null, grade || 1, score, total, percentage);
    if (Array.isArray(mistakes)) {
      const ins = db.prepare('INSERT INTO student_mistakes (student_id, lesson_id, question_text, chosen_answer, correct_answer, concept_tag) VALUES (?, ?, ?, ?, ?, ?)');
      mistakes.forEach((m) => ins.run(student.id, lesson_id || null, m.question_text, m.chosen_answer, m.correct_answer, m.concept_tag || 'عام'));
    }
    res.json({ success: true, percentage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/tutor', upload.single('image'), async (req, res) => {
  try {
    const { question, grade, track, lessonTitle } = req.body;
    const file = req.file;
    if (!ai) {
      return res.json({
        answer: track === 'en'
          ? 'Note: Please add your GEMINI_API_KEY inside the .env file to enable live AI tutoring and image solving.'
          : 'تنبيه: يرجى وضع مفتاح GEMINI_API_KEY داخل ملف .env لتفعيل المدرس الذكي وتحليل صور المسائل.'
      });
    }
    const systemInstruction = track === 'en'
      ? \`You are an expert Egyptian Ministry of Education Mathematics Tutor for Prep \${grade} (Languages Track). Lesson: "\${lessonTitle}". Explain step-by-step clearly.\`
      : \`أنت معلم خبير في منهج الرياضيات المصري للمرحلة الإعدادية (الصف \${grade}). الدرس: "\${lessonTitle}". اشرح خطوة بخطوة بوضوح.\`;
    const contents = [];
    if (file) {
      contents.push({ inlineData: { data: file.buffer.toString('base64'), mimeType: file.mimetype } });
    }
    contents.push(question || (track === 'en' ? 'Solve this math problem step by step.' : 'اشرح وحل هذه المسألة خطوة بخطوة.'));
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents, config: { systemInstruction } });
    res.json({ answer: response.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/generate-quiz', async (req, res) => {
  try {
    const { lessonTitle, lessonExplain, grade, count = 3 } = req.body;
    if (!ai) return res.status(400).json({ error: 'Missing GEMINI_API_KEY in .env' });
    const prompt = \`Create \${count} multiple-choice math questions for Egyptian Prep \${grade} on lesson "\${lessonTitle}" (\${lessonExplain}). Return ONLY a JSON array with keys: question_ar, question_en, options_ar (array of 4), options_en (array of 4), correct_index (0-3), explanation_ar, explanation_en, concept_tag.\`;
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: 'application/json' } });
    res.json({ questions: JSON.parse(response.text) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/analyze-mistakes', async (req, res) => {
  try {
    const { student_code, track } = req.body;
    const student = db.prepare('SELECT * FROM students WHERE code = ?').get(student_code);
    const mistakes = student ? db.prepare('SELECT * FROM student_mistakes WHERE student_id = ? ORDER BY created_at DESC LIMIT 15').all(student.id) : [];
    if (mistakes.length === 0) {
      return res.json({ analysis: track === 'en' ? 'No mistakes recorded yet!' : 'لا توجد أخطاء مسجلة حتى الآن!' });
    }
    if (!ai) {
      return res.json({ analysis: track === 'en' ? \`Recorded mistakes: \${mistakes.length}. Add GEMINI_API_KEY in .env for full AI analysis.\` : \`عدد الأخطاء المسجلة: \${mistakes.length}. أضف مفتاح GEMINI_API_KEY في ملف .env للحصول على خطة علاجية بالذكاء الاصطناعي.\` });
    }
    const prompt = track === 'en'
      ? \`Analyze these math mistakes and give a remedial plan:\\n\${JSON.stringify(mistakes)}\`
      : \`حلل أخطاء الطالب التالية في الرياضيات وقدم خطة علاجية مبسطة:\\n\${JSON.stringify(mistakes)}\`;
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt });
    res.json({ analysis: response.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/overview', (req, res) => {
  try {
    const unitsCount = db.prepare('SELECT COUNT(*) as c FROM units').get().c;
    const lessonsCount = db.prepare('SELECT COUNT(*) as c FROM lessons').get().c;
    const questionsCount = db.prepare('SELECT COUNT(*) as c FROM questions').get().c;
    const students = db.prepare(\`
      SELECT s.*,
        (SELECT COUNT(*) FROM student_progress sp WHERE sp.student_id = s.id) as completed_lessons,
        (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.student_id = s.id) as total_quizzes,
        (SELECT AVG(percentage) FROM quiz_attempts qa WHERE qa.student_id = s.id) as avg_score
      FROM students s ORDER BY s.id DESC
    \`).all();
    res.json({ unitsCount, lessonsCount, questionsCount, students });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('====================================================');
  console.log('🚀 المنصة تعمل الآن! افتح المتصفح على الرابط:');
  console.log('👉 http://localhost:' + PORT);
  console.log('====================================================');
});
`;
fs.writeFileSync(path.join(__dirname, 'server.js'), serverCode, 'utf8');
console.log('✅ [4/4] تم إنشاء ملف الخادم server.js');

console.log('\n🎉 تم إنشاء جميع الملفات بنجاح!');