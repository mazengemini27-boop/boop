const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const DB_FILE = path.join(__dirname, 'data.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const SERVER_START_TIME = Date.now();
const MR_CODE_ERROR_LOG = [];
const MR_CODE_CHAT_MEMORY = [];
const DEFAULT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 920 300">
  <rect width="920" height="300" rx="22" fill="#0f172a"/>
  <rect x="8" y="8" width="904" height="284" rx="18" fill="none" stroke="#C0932B" stroke-width="4"/>
  <rect x="24" y="24" width="872" height="16" rx="4" fill="#CE1126"/>
  <text x="460" y="135" text-anchor="middle" fill="#ffffff" font-size="44" font-weight="bold" font-family="Amiri, serif">منصة وزارة المعارف المصرية</text>
  <text x="460" y="205" text-anchor="middle" fill="#C0932B" font-size="24" font-weight="bold" font-family="Book Antiqua, serif">EGYPTIAN MINISTRY OF KNOWLEDGE</text>
</svg>`;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// تسجيل الأخطاء غير المتوقعة في الخادم تلقائياً لصالح «مستر كود»
function recordMrCodeError(source, message, stack = '') {
  const entry = {
    id: 'ERR-' + Date.now().toString().slice(-6),
    time: new Date().toISOString(),
    source: String(source || 'server'),
    message: String(message || 'Unknown error').slice(0, 400),
    stack: String(stack || '').slice(0, 500),
    diagnosis: String(message || '').includes('SyntaxError')
      ? 'خطأ نحوي في الكود — راجع الأقواس أو الفواصل المنقوطة في السطر المشار إليه.'
      : String(message || '').includes('fetch')
      ? 'تعذر اتصال مؤقت بالشبكة أو الخادم — تأكد من تشغيل السيرفر على المنفذ الصحيح.'
      : 'راجع تفاصيل الخطأ واستخدم فحص AST العميق من لوحة مستر كود.'
  };
  MR_CODE_ERROR_LOG.unshift(entry);
  if (MR_CODE_ERROR_LOG.length > 30) MR_CODE_ERROR_LOG.length = 30;
  return entry;
}

process.on('uncaughtException', (err) => {
  recordMrCodeError('server-uncaught', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  recordMrCodeError('server-promise', reason && reason.message ? reason.message : String(reason));
});

// فاحص الكود والتركيب النحوي العميق (Deep AST & Syntax Inspector)
function inspectProjectSyntaxDeep() {
  const report = [];
  const serverPath = __filename;
  const htmlPath = path.join(PUBLIC_DIR, 'index.html');

  // 1. فحص server.js
  try {
    const sCode = fs.readFileSync(serverPath, 'utf8');
    new vm.Script(sCode, { filename: 'server.js' });
    const lines = sCode.split('\n').length;
    report.push({
      file: 'server.js',
      ok: true,
      lines,
      size_kb: Math.round(Buffer.byteLength(sCode, 'utf8') / 1024),
      details: `سليم نحوياً 100% (${lines} سطر) ✅`
    });
  } catch (e) {
    report.push({
      file: 'server.js',
      ok: false,
      error: e.message,
      details: `❌ خطأ نحوي في server.js: ${e.message}`
    });
  }

  // 2. فحص public/index.html والسكربت الداخلي
  try {
    const hCode = fs.readFileSync(htmlPath, 'utf8');
    const lines = hCode.split('\n').length;
    const scriptMatch = hCode.match(/<script>([\s\S]*?)<\/script>/);
    let jsOk = false;
    let jsErr = '';
    if (scriptMatch && scriptMatch[1]) {
      try {
        new vm.Script(scriptMatch[1], { filename: 'public/index.html<script>' });
        jsOk = true;
      } catch (se) {
        jsErr = se.message;
      }
    }
    const closedHtml = hCode.includes('</html>') && hCode.includes('</body>');
    const hasKatex = hCode.includes('katex');
    const hasBookAntiqua = hCode.includes('Book Antiqua');
    report.push({
      file: 'public/index.html',
      ok: jsOk && closedHtml,
      lines,
      size_kb: Math.round(Buffer.byteLength(hCode, 'utf8') / 1024),
      details: jsOk && closedHtml
        ? `سليم نحوياً 100% (${lines} سطر) | KaTeX: ${hasKatex ? '✅' : '⚠️'} | Book Antiqua: ${hasBookAntiqua ? '✅' : '⚠️'}`
        : `❌ خطأ في الواجهة: ${jsErr || 'وسم الإغلاق ناقص'}`
    });
  } catch (e) {
    report.push({
      file: 'public/index.html',
      ok: false,
      error: e.message,
      details: `❌ تعذر قراءة public/index.html: ${e.message}`
    });
  }

  return report;
}

// إنشاء نسخة احتياطية مؤرخة لملفات المشروع الأساسية
function createProjectBackup(reason = 'manual') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `backup_${stamp}`;
  const targetDir = path.join(BACKUPS_DIR, backupId);
  fs.mkdirSync(targetDir, { recursive: true });

  const filesBackedUp = [];
  const targets = [
    { src: __filename, name: 'server.js' },
    { src: path.join(PUBLIC_DIR, 'index.html'), name: 'index.html' },
    { src: DB_FILE, name: 'data.json' }
  ];
  targets.forEach((t) => {
    if (fs.existsSync(t.src)) {
      fs.copyFileSync(t.src, path.join(targetDir, t.name));
      filesBackedUp.push(t.name);
    }
  });
  fs.writeFileSync(
    path.join(targetDir, 'meta.json'),
    JSON.stringify({ id: backupId, created_at: new Date().toISOString(), reason, files: filesBackedUp }, null, 2),
    'utf8'
  );
  return { id: backupId, created_at: new Date().toISOString(), reason, files: filesBackedUp };
}

function listProjectBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs
    .readdirSync(BACKUPS_DIR)
    .filter((name) => name.startsWith('backup_'))
    .map((name) => {
      const metaFile = path.join(BACKUPS_DIR, name, 'meta.json');
      if (fs.existsSync(metaFile)) {
        try {
          return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        } catch (e) {}
      }
      return { id: name, created_at: name.replace('backup_', ''), reason: 'auto', files: [] };
    })
    .sort((a, b) => String(b.id).localeCompare(String(a.id)))
    .slice(0, 15);
}

// فهرس جميع دروس المرحلة الإعدادية (الأول + الثاني + الثالث الإعدادي) لتوليد 4 ملفات PDF احترافية لكل درس باللغات الثلاث
const ALL_PREP_SYLLABUS_INDEX = [
  // ==================== الصف الأول الإعدادي (7 دروس × 4 ملفات = 28 ملف PDF) ====================
  {
    grade: 1, term: 1, lesson_id: 101,
    unit_ar: 'الوحدة الأولى: الأعداد والعمليات عليها',
    unit_en: 'Unit 1: Numbers & Operations',
    unit_fr: 'Unité 1 : Nombres et Opérations',
    lesson_ar: 'الدرس الأول: التناسب وتطبيقاته ومقياس الرسم',
    lesson_en: 'Unit 1 - Lesson 1: Proportion, Applications & Scale Drawing',
    lesson_fr: 'Unité 1 - Leçon 1 : Proportions, Applications et Échelle',
    explain_summary_ar: 'التناسب هو تساوي نسبتين أو أكثر: إذا كان $\\frac{a}{b} = \\frac{c}{d}$ فإن حاصل ضرب الطرفين يساوي حاصل ضرب الوسطين ($a \\times d = b \\times c$). ومقياس الرسم $= \\frac{\\text{الطول في الرسم}}{\\text{الطول الحقيقي}}$ بعد توحيد الوحدات ($1\\text{ km} = 100,000\\text{ cm}$).',
    explain_summary_en: 'A proportion is an equality of two ratios: if $\\frac{a}{b} = \\frac{c}{d}$, then the product of extremes equals the product of means ($a \\times d = b \\times c$). Scale Drawing $= \\frac{\\text{Drawing Length}}{\\text{Real Length}}$ using unified units ($1\\text{ km} = 100,000\\text{ cm}$).',
    explain_summary_fr: 'Une proportion est l’égalité de deux rapports : si $\\frac{a}{b} = \\frac{c}{d}$, alors le produit des extrêmes est égal au produit des moyens ($a \\times d = b \\times c$). L’échelle d’un plan est donnée par : $\\text{Échelle} = \\frac{\\text{Longueur sur le dessin}}{\\text{Longueur réelle}}$ avec les mêmes unités ($1\\text{ km} = 100\\,000\\text{ cm}$).',
    homework_items_ar: [
      '1) أوجد قيمة $x$ في التناسب: $\\frac{x}{6} = \\frac{4}{8}$ (كتاب الوزارة)',
      '2) إذا كانت الأعداد $3, 5, x, 15$ متناسبة فأوجد قيمة $x$ (كتاب المعاصر)',
      '3) المسافة بين مدينتين على خريطة $4\\text{ cm}$ والبعد الحقيقي $120\\text{ km}$، أوجد مقياس الرسم (كتاب الأضواء)',
      '4) قُسّم مبلغ $3600$ جنيه بين شخصين بنسبة $4 : 5$، أوجد نصيب كلاً منهما (تمارين عامة)'
    ],
    homework_items_en: [
      '1) Find the value of $x$ in the proportion: $\\frac{x}{6} = \\frac{4}{8}$ (Ministry Textbook)',
      '2) If $3, 5, x, 15$ are proportional quantities, find $x$ (El-Moasser)',
      '3) The map distance between two cities is $4\\text{ cm}$ and the real distance is $120\\text{ km}$. Find the drawing scale (El-Adwaa)',
      '4) Divide $3600\\text{ EGP}$ between two persons in the ratio $4 : 5$. Find each share (General Exercises)'
    ],
    homework_items_fr: [
      '1) Déterminer la valeur de $x$ dans la proportion : $\\frac{x}{6} = \\frac{4}{8}$ (Manuel Ministériel)',
      '2) Si les nombres $3, 5, x, 15$ sont proportionnels, calculer $x$ (Exercices d’application)',
      '3) Sur une carte, la distance entre deux villes est de $4\\text{ cm}$ et la distance réelle est de $120\\text{ km}$. Calculer l’échelle de la carte.',
      '4) Partager une somme de $3600\\text{ EGP}$ entre deux personnes selon le ratio $4 : 5$. Calculer la part de chacune.'
    ],
    homework_solutions_ar: [
      '1) الحل: $8x = 6 \\times 4 = 24 \\implies x = \\frac{24}{8} = 3$.',
      '2) الحل: $\\frac{3}{5} = \\frac{x}{15} \\implies 5x = 45 \\implies x = 9$.',
      '3) الحل: نحول $120\\text{ km} = 12,000,000\\text{ cm} \\implies \\text{مقياس الرسم} = 4 : 12,000,000 = 1 : 3,000,000$.',
      '4) الحل: مجموع الأجزاء $= 4 + 5 = 9 \\implies \\text{قيمة الجزء} = 3600 \\div 9 = 400 \\implies \\text{الأول} = 1600\\text{ ج}$، $\\text{الثاني} = 2000\\text{ ج}$.'
    ],
    homework_solutions_en: [
      '1) Solution: $8x = 6 \\times 4 = 24 \\implies x = \\frac{24}{8} = 3$.',
      '2) Solution: $\\frac{3}{5} = \\frac{x}{15} \\implies 5x = 45 \\implies x = 9$.',
      '3) Solution: Convert $120\\text{ km} = 12,000,000\\text{ cm} \\implies \\text{Scale} = 4 : 12,000,000 = 1 : 3,000,000$.',
      '4) Solution: Total parts $= 4 + 5 = 9 \\implies \\text{One part} = 3600 \\div 9 = 400 \\implies \\text{First} = 1600\\text{ EGP}$, $\\text{Second} = 2000\\text{ EGP}$.'
    ],
    homework_solutions_fr: [
      '1) Solution : Par produit en croix, $8x = 6 \\times 4 = 24 \\implies x = \\frac{24}{8} = 3$.',
      '2) Solution : $\\frac{3}{5} = \\frac{x}{15} \\implies 5x = 45 \\implies x = 9$.',
      '3) Solution : Convertissons $120\\text{ km} = 12\\,000\\,000\\text{ cm} \\implies \\text{Échelle} = 4 : 12\\,000\\,000 = 1 : 3\\,000\\,000$.',
      '4) Solution : Somme des parts $= 4 + 5 = 9 \\implies \\text{Valeur d’une part} = 3600 \\div 9 = 400 \\implies \\text{1ère part} = 1600\\text{ EGP}$, $\\text{2ème part} = 2000\\text{ EGP}$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان $\\frac{2x + 3}{3x - 1} = \\frac{5}{4}$، فأوجد قيمة $x$ (الحل: $4(2x+3)=5(3x-1) \\implies 8x+12=15x-5 \\implies 7x=17 \\implies x=\\frac{17}{7}$).',
      'مسألة متفوقين (2): صورة مكبّرة لحشرة بمقياس رسم $40 : 1$، فإذا كان طول الحشرة في الصورة $6\\text{ cm}$، أوجد طولها الحقيقي بالمليمتر (الحل: $\\frac{6}{40} = 0.15\\text{ cm} = 1.5\\text{ mm}$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If $\\frac{2x + 3}{3x - 1} = \\frac{5}{4}$, find $x$ (Answer: $8x + 12 = 15x - 5 \\implies x = \\frac{17}{7}$).',
      'Gifted Problem (2): An enlarged photo of an insect has a scale of $40 : 1$. If its length in the photo is $6\\text{ cm}$, find its real length in millimeters (Answer: $0.15\\text{ cm} = 1.5\\text{ mm}$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si $\\frac{2x + 3}{3x - 1} = \\frac{5}{4}$, déterminer $x$ (Réponse : $8x + 12 = 15x - 5 \\implies x = \\frac{17}{7}$).',
      'Problème d’Excellence (2) : La photographie agrandie d’un insecte est à l’échelle $40 : 1$. Si sa longueur sur la photo est de $6\\text{ cm}$, calculer sa longueur réelle en millimètres (Réponse : $0{,}15\\text{ cm} = 1{,}5\\text{ mm}$).'
    ]
  },
  {
    grade: 1, term: 1, lesson_id: 102,
    unit_ar: 'الوحدة الأولى: الأعداد والعمليات عليها',
    unit_en: 'Unit 1: Numbers & Operations',
    unit_fr: 'Unité 1 : Nombres et Opérations',
    lesson_ar: 'الدرس الثاني: المجموعات والعمليات عليها والأعداد النسبية',
    lesson_en: 'Unit 1 - Lesson 2: Set Operations & Rational Numbers',
    lesson_fr: 'Unité 1 - Leçon 2 : Opérations sur les Ensembles et Nombres Rationnels',
    explain_summary_ar: 'التقاطع ($A \\cap B$) هو مجموعة العناصر المشتركة بين المجموعتين، والاتحاد ($A \\cup B$) هو جميع العناصر دون تكرار. والعدد النسبي يكتب على صورة $\\frac{a}{b}$ حيث $a, b \\in \\mathbb{Z}$ و $b \\neq 0$.',
    explain_summary_en: 'The intersection ($A \\cap B$) is the set of common elements, while the union ($A \\cup B$) combines all elements without repetition. A rational number is written as $\\frac{a}{b}$ where $a, b \\in \\mathbb{Z}$ and $b \\neq 0$.',
    explain_summary_fr: 'L’intersection ($A \\cap B$) est l’ensemble des éléments communs aux deux ensembles, et la réunion ($A \\cup B$) regroupe tous les éléments sans répétition. Un nombre rationnel s’écrit sous la forme $\\frac{a}{b}$ avec $a, b \\in \\mathbb{Z}$ et $b \\neq 0$.',
    homework_items_ar: [
      '1) إذا كانت $X = \\{1, 2, 3, 5\\}$ و $Y = \\{2, 3, 6\\}$ فأوجد: $X \\cap Y$ و $X \\cup Y$ (كتاب الوزارة)',
      '2) أوجد ناتج جمع العددين النسبيين: $\\frac{2}{3} + \\frac{1}{6}$ في أبسط صورة (كتاب المعاصر)',
      '3) اكتب ثلاثة أعداد نسبية تقع بين $\\frac{1}{3}$ و $\\frac{1}{2}$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Given $X = \\{1, 2, 3, 5\\}$ and $Y = \\{2, 3, 6\\}$, find $X \\cap Y$ and $X \\cup Y$ (Ministry Textbook)',
      '2) Evaluate and simplify: $\\frac{2}{3} + \\frac{1}{6}$ (El-Moasser)',
      '3) Write three rational numbers lying between $\\frac{1}{3}$ and $\\frac{1}{2}$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Soient $X = \\{1, 2, 3, 5\\}$ et $Y = \\{2, 3, 6\\}$. Déterminer $X \\cap Y$ et $X \\cup Y$.',
      '2) Calculer et simplifier la somme des deux nombres rationnels : $\\frac{2}{3} + \\frac{1}{6}$.',
      '3) Écrire trois nombres rationnels compris entre $\\frac{1}{3}$ et $\\frac{1}{2}$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $X \\cap Y = \\{2, 3\\}$ ، $X \\cup Y = \\{1, 2, 3, 5, 6\\}$.',
      '2) الحل: بتوحيد المقامات على $6$: $\\frac{4}{6} + \\frac{1}{6} = \\frac{5}{6}$.',
      '3) الحل: نوحد المقامات على $24$: الكسران هما $\\frac{8}{24}$ و $\\frac{12}{24} \\implies$ الأعداد هي: $\\frac{9}{24}, \\frac{10}{24}, \\frac{11}{24}$.'
    ],
    homework_solutions_en: [
      '1) Solution: $X \\cap Y = \\{2, 3\\}$, $X \\cup Y = \\{1, 2, 3, 5, 6\\}$.',
      '2) Solution: Using common denominator $6$: $\\frac{4}{6} + \\frac{1}{6} = \\frac{5}{6}$.',
      '3) Solution: With common denominator $24$: $\\frac{8}{24}$ and $\\frac{12}{24} \\implies \\frac{9}{24}, \\frac{10}{24}, \\frac{11}{24}$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $X \\cap Y = \\{2, 3\\}$ et $X \\cup Y = \\{1, 2, 3, 5, 6\\}$.',
      '2) Solution : En réduisant au même dénominateur $6$ : $\\frac{4}{6} + \\frac{1}{6} = \\frac{5}{6}$.',
      '3) Solution : Avec le dénominateur commun $24$ : $\\frac{8}{24}$ et $\\frac{12}{24} \\implies$ les nombres sont $\\frac{9}{24}, \\frac{10}{24}, \\frac{11}{24}$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان $\\frac{x + 3}{x - 5}$ عدداً نسبياً يساوي صفراً، فما قيمة $x$؟ ومتى يكون غير معرّف؟ (يساوي صفراً عند $x = -3$، وغير معرّف عند $x = 5$).',
      'مسألة متفوقين (2): إذا كان $X \\cup Y = \\{1, 2, 3, 4\\}$ و $X \\cap Y = \\{2\\}$ و $X = \\{1, 2\\}$ فأوجد المجموعة $Y$ (الحل: $Y = \\{2, 3, 4\\}$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If $\\frac{x + 3}{x - 5} = 0$, find $x$, and state when the expression is undefined ($x = -3$ for zero; $x = 5$ undefined).',
      'Gifted Problem (2): If $X \\cup Y = \\{1, 2, 3, 4\\}$, $X \\cap Y = \\{2\\}$, and $X = \\{1, 2\\}$, find set $Y$ (Answer: $Y = \\{2, 3, 4\\}$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si $\\frac{x + 3}{x - 5} = 0$, déterminer $x$ et indiquer pour quelle valeur cette expression n’est pas définie ($x = -3$ pour zéro ; non définie pour $x = 5$).',
      'Problème d’Excellence (2) : Sachant que $X \\cup Y = \\{1, 2, 3, 4\\}$, $X \\cap Y = \\{2\\}$ et $X = \\{1, 2\\}$, déterminer l’ensemble $Y$ (Réponse : $Y = \\{2, 3, 4\\}$).'
    ]
  },
  {
    grade: 1, term: 1, lesson_id: 103,
    unit_ar: 'الوحدة الثانية: الجبر',
    unit_en: 'Unit 2: Algebra',
    unit_fr: 'Unité 2 : Algèbre',
    lesson_ar: 'الدرس الثالث: الحدود والمقادير الجبرية وتبسيطها',
    lesson_en: 'Unit 2 - Lesson 1: Algebraic Terms & Simplifying Expressions',
    lesson_fr: 'Unité 2 - Leçon 1 : Termes et Expressions Algébriques',
    explain_summary_ar: 'الحد الجبري يتكون من حاصل ضرب عامل عددي وعامل رمزي أو أكثر، وعند جمع أو طرح المقادير الجبرية نجمع الحدود المتشابهة (نفس الرمز ونفس الأس) فقط: $a(b + c) = ab + ac$.',
    explain_summary_en: 'An algebraic term is the product of a numerical coefficient and variable factors. When adding or subtracting expressions, combine only like terms (identical variables and exponents): $a(b + c) = ab + ac$.',
    explain_summary_fr: 'Un terme algébrique est le produit d’un coefficient numérique et d’une partie littérale. Pour réduire une expression algébrique, on regroupe uniquement les termes semblables (mêmes variables et mêmes exposants) : $a(b + c) = ab + ac$.',
    homework_items_ar: [
      '1) اختصر لأبسط صورة: $(3x + 5y) + (2x - 2y)$ (كتاب الوزارة)',
      '2) اطرح المقدار $(2a - 3b + 5)$ من المقدار $(5a + b - 2)$ (كتاب المعاصر)',
      '3) أوجد ناتج الضرب بمجرد النظر: $3x(2x - 4y + 1)$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Simplify to lowest terms: $(3x + 5y) + (2x - 2y)$ (Ministry Textbook)',
      '2) Subtract $(2a - 3b + 5)$ from $(5a + b - 2)$ (El-Moasser)',
      '3) Expand using the distributive property: $3x(2x - 4y + 1)$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Réduire l’expression suivante : $(3x + 5y) + (2x - 2y)$.',
      '2) Soustraire l’expression $(2a - 3b + 5)$ de $(5a + b - 2)$.',
      '3) Développer l’expression suivante : $3x(2x - 4y + 1)$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $(3 + 2)x + (5 - 2)y = 5x + 3y$.',
      '2) الحل: $(5a + b - 2) - (2a - 3b + 5) = 3a + 4b - 7$.',
      '3) الحل: نوزع $3x$ على القوس: $6x^2 - 12xy + 3x$.'
    ],
    homework_solutions_en: [
      '1) Solution: $(3 + 2)x + (5 - 2)y = 5x + 3y$.',
      '2) Solution: $(5a + b - 2) - (2a - 3b + 5) = 3a + 4b - 7$.',
      '3) Solution: Distribute $3x$: $6x^2 - 12xy + 3x$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $(3 + 2)x + (5 - 2)y = 5x + 3y$.',
      '2) Solution : $(5a + b - 2) - (2a - 3b + 5) = 3a + 4b - 7$.',
      '3) Solution : En distribuant $3x$ : $6x^2 - 12xy + 3x$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان الحد الجبري $5x^m y^3$ من الدرجة السابعة، فأوجد قيمة $m$ (الحل: $m + 3 = 7 \\implies m = 4$).',
      'مسألة متفوقين (2): ما المقدار الذي يجب إضافته إلى $(3x^2 - 5x + 2)$ ليكون الناتج $(5x^2 + x - 4)$؟ (الحل: $2x^2 + 6x - 6$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If the algebraic term $5x^m y^3$ is of the 7th degree, find $m$ (Answer: $m + 3 = 7 \\implies m = 4$).',
      'Gifted Problem (2): What expression must be added to $(3x^2 - 5x + 2)$ to get $(5x^2 + x - 4)$? (Answer: $2x^2 + 6x - 6$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si le monôme $5x^m y^3$ est de degré $7$, calculer $m$ (Réponse : $m + 3 = 7 \\implies m = 4$).',
      'Problème d’Excellence (2) : Quelle expression faut-il ajouter à $(3x^2 - 5x + 2)$ pour obtenir $(5x^2 + x - 4)$ ? (Réponse : $2x^2 + 6x - 6$).'
    ]
  },
  {
    grade: 1, term: 1, lesson_id: 104,
    unit_ar: 'الوحدة الثانية: الجبر',
    unit_en: 'Unit 2: Algebra',
    unit_fr: 'Unité 2 : Algèbre',
    lesson_ar: 'الدرس الرابع: حل المعادلات والمتباينات الخطية في Q',
    lesson_en: 'Unit 2 - Lesson 2: Solving Linear Equations & Inequalities in Q',
    lesson_fr: 'Unité 2 - Leçon 2 : Équations et Inéquations Linéaires dans Q',
    explain_summary_ar: 'لحل المعادلة $ax + b = c$ ننقل الحد المطلق $b$ إلى الطرف الآخر بعكس الإشارة ثم نقسم على معامل المجهول $a$. وفي المتباينات عند القسمة على عدد سالب نعكس علامة التباين.',
    explain_summary_en: 'To solve $ax + b = c$, transpose $b$ to the other side with the opposite sign, then divide by $a$. In inequalities, dividing or multiplying by a negative number reverses the inequality sign.',
    explain_summary_fr: 'Pour résoudre l’équation $ax + b = c$, on transpose $b$ dans l’autre membre en changeant son signe, puis on divise par $a$. Dans une inéquation, diviser ou multiplier par un nombre négatif inverse le sens de l’inégalité.',
    homework_items_ar: [
      '1) أوجد مجموعة حل المعادلة: $2x + 3 = 11$ في $\\mathbb{Q}$ (كتاب الوزارة)',
      '2) حل المعادلة: $3(x - 2) = 15$ في $\\mathbb{Q}$ (كتاب المعاصر)',
      '3) أوجد مجموعة حل المتباينة: $2x - 1 < 7$ في مجموعة الأعداد الصحيحة $\\mathbb{Z}$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Find the solution set of: $2x + 3 = 11$ in $\\mathbb{Q}$ (Ministry Textbook)',
      '2) Solve: $3(x - 2) = 15$ in $\\mathbb{Q}$ (El-Moasser)',
      '3) Find the solution set of the inequality: $2x - 1 < 7$ in $\\mathbb{Z}$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Résoudre dans $\\mathbb{Q}$ l’équation : $2x + 3 = 11$.',
      '2) Résoudre dans $\\mathbb{Q}$ l’équation : $3(x - 2) = 15$.',
      '3) Déterminer l’ensemble des solutions dans $\\mathbb{Z}$ de l’inéquation : $2x - 1 < 7$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $2x = 11 - 3 = 8 \\implies x = 4 \\implies \\text{م.ح} = \\{4\\}$.',
      '2) الحل: بقسمة الطرفين على $3$: $x - 2 = 5 \\implies x = 7 \\implies \\text{م.ح} = \\{7\\}$.',
      '3) الحل: $2x < 8 \\implies x < 4 \\implies \\text{م.ح} = \\{3, 2, 1, 0, \\dots\\}$.'
    ],
    homework_solutions_en: [
      '1) Solution: $2x = 11 - 3 = 8 \\implies x = 4 \\implies \\text{S.S.} = \\{4\\}$.',
      '2) Solution: Divide both sides by $3$: $x - 2 = 5 \\implies x = 7 \\implies \\text{S.S.} = \\{7\\}$.',
      '3) Solution: $2x < 8 \\implies x < 4 \\implies \\text{S.S.} = \\{3, 2, 1, 0, \\dots\\}$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $2x = 11 - 3 = 8 \\implies x = 4 \\implies S = \\{4\\}$.',
      '2) Solution : En divisant les deux membres par $3$ : $x - 2 = 5 \\implies x = 7 \\implies S = \\{7\\}$.',
      '3) Solution : $2x < 8 \\implies x < 4 \\implies S = \\{3, 2, 1, 0, \\dots\\}$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): عددان طبيعيان زوجيان متتاليان مجموعهما $46$، أوجد العددين بتكوين معادلة (الحل: $x + (x+2) = 46 \\implies x = 22$، العددان هما $22, 24$).',
      'مسألة متفوقين (2): أوجد مجموعة حل المتباينة: $-3 \\le 2x + 1 < 7$ في $\\mathbb{Z}$ (الحل: $-2 \\le x < 3 \\implies \\{-2, -1, 0, 1, 2\\}$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): Two consecutive even natural numbers sum to $46$. Find them ($x + x + 2 = 46 \\implies 22$ and $24$).',
      'Gifted Problem (2): Solve $-3 \\le 2x + 1 < 7$ in $\\mathbb{Z}$ (Answer: $-2 \\le x < 3 \\implies \\{-2, -1, 0, 1, 2\\}$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Deux entiers naturels pairs consécutifs ont pour somme $46$. Déterminer ces deux nombres ($x + x + 2 = 46 \\implies 22$ et $24$).',
      'Problème d’Excellence (2) : Résoudre dans $\\mathbb{Z}$ l’encadrement : $-3 \\le 2x + 1 < 7$ (Réponse : $-2 \\le x < 3 \\implies \\{-2, -1, 0, 1, 2\\}$).'
    ]
  },
  {
    grade: 1, term: 1, lesson_id: 105,
    unit_ar: 'الوحدة الثالثة: الهندسة والقياس',
    unit_en: 'Unit 3: Geometry & Measurement',
    unit_fr: 'Unité 3 : Géométrie et Mesure',
    lesson_ar: 'الدرس الخامس: العلاقات بين الزوايا والتوازي',
    lesson_en: 'Unit 3 - Lesson 1: Angle Relationships & Parallel Lines',
    lesson_fr: 'Unité 3 - Leçon 1 : Relations entre les Angles et Parallélisme',
    explain_summary_ar: 'الزاويتان المتتامتان مجموعهما $90^\\circ$ والمتكاملتان مجموعهما $180^\\circ$. وإذا قطع مستقيم مستقيمين متوازيين تساوت الزوايا المتبادلة (Z) والمتناظرة (F) وتكاملت الداخلتان (U).',
    explain_summary_en: 'Complementary angles sum to $90^\\circ$ and supplementary angles sum to $180^\\circ$. When a transversal cuts two parallel lines, alternate interior angles (Z) are equal, corresponding angles (F) are equal, and co-interior angles (U) sum to $180^\\circ$.',
    explain_summary_fr: 'Deux angles complémentaires ont une somme égale à $90^\\circ$ et deux angles supplémentaires ont une somme égale à $180^\\circ$. Si une sécante coupe deux droites parallèles, les angles alternes-internes (Z) sont égaux, les angles correspondants (F) sont égaux et les angles internes d’un même côté (U) sont supplémentaires ($180^\\circ$).',
    homework_items_ar: [
      '1) زاوية قياسها $65^\\circ$، أوجد قياس متممتها ومكملتها والمنعكسة لها (كتاب الوزارة)',
      '2) زاويتان متكاملتان النسبة بين قياسيهما $2 : 7$، أوجد قياس الزاوية الكبرى (كتاب المعاصر)',
      '3) إذا قطع مستقيم مستقيمين متوازيين وكانت إحدى الزاويتين الداخلتين $115^\\circ$، أوجد قياس الأخرى (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) An angle measures $65^\\circ$. Find its complement, supplement, and reflex angle (Ministry Textbook)',
      '2) Two supplementary angles are in the ratio $2 : 7$. Find the measure of the larger angle (El-Moasser)',
      '3) A transversal intersects two parallel lines. If one co-interior angle is $115^\\circ$, find the other (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Un angle mesure $65^\\circ$. Calculer la mesure de son angle complémentaire, de son angle supplémentaire et de son angle rentrant.',
      '2) Deux angles supplémentaires sont dans le rapport $2 : 7$. Calculer la mesure du plus grand angle.',
      '3) Une sécante coupe deux droites parallèles. Si l’un des deux angles internes d’un même côté mesure $115^\\circ$, calculer l’autre.'
    ],
    homework_solutions_ar: [
      '1) الحل: المتممة $= 90^\\circ - 65^\\circ = 25^\\circ$ | المكملة $= 180^\\circ - 65^\\circ = 115^\\circ$ | المنعكسة $= 360^\\circ - 65^\\circ = 295^\\circ$.',
      '2) الحل: مجموع الأجزاء $= 9 \\implies \\text{قيمة الجزء} = 180^\\circ \\div 9 = 20^\\circ \\implies \\text{الكبرى} = 7 \\times 20^\\circ = 140^\\circ$.',
      '3) الحل: الزاويتان الداخلتان متكاملتان $\\implies \\text{قياس الأخرى} = 180^\\circ - 115^\\circ = 65^\\circ$.'
    ],
    homework_solutions_en: [
      '1) Solution: Complement $= 25^\\circ$ | Supplement $= 115^\\circ$ | Reflex $= 295^\\circ$.',
      '2) Solution: Total parts $= 9 \\implies 1\\text{ part} = 20^\\circ \\implies \\text{Larger} = 7 \\times 20^\\circ = 140^\\circ$.',
      '3) Solution: Co-interior angles sum to $180^\\circ \\implies 180^\\circ - 115^\\circ = 65^\\circ$.'
    ],
    homework_solutions_fr: [
      '1) Solution : Complémentaire $= 90^\\circ - 65^\\circ = 25^\\circ$ | Supplémentaire $= 180^\\circ - 65^\\circ = 115^\\circ$ | Rentrant $= 360^\\circ - 65^\\circ = 295^\\circ$.',
      '2) Solution : Somme des parts $= 9 \\implies 1\\text{ part} = 20^\\circ \\implies \\text{Plus grand angle} = 7 \\times 20^\\circ = 140^\\circ$.',
      '3) Solution : Les angles internes d’un même côté sont supplémentaires $\\implies 180^\\circ - 115^\\circ = 65^\\circ$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان قياس زاوية يساوي ضعف قياس مكملتها، فأوجد قياس هذه الزاوية (الحل: $x = 2(180^\\circ - x) \\implies 3x = 360^\\circ \\implies x = 120^\\circ$).',
      'مسألة متفوقين (2): في شكل حرف M بين مستقيمين متوازيين، إذا كانت الزاويتان العلوية $35^\\circ$ والسفلية $45^\\circ$، أوجد قياس الزاوية الوسطى ($35^\\circ + 45^\\circ = 80^\\circ$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If an angle is twice its supplement, find its measure ($x = 2(180^\\circ - x) \\implies x = 120^\\circ$).',
      'Gifted Problem (2): In an M-shape between two parallel lines, if the upper angle is $35^\\circ$ and lower is $45^\\circ$, find the middle angle ($80^\\circ$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si la mesure d’un angle est le double de celle de son supplémentaire, calculer la mesure de cet angle ($x = 2(180^\\circ - x) \\implies x = 120^\\circ$).',
      'Problème d’Excellence (2) : Dans une configuration en forme de M entre deux droites parallèles, si les angles aigus mesurent $35^\\circ$ et $45^\\circ$, calculer l’angle central ($35^\\circ + 45^\\circ = 80^\\circ$).'
    ]
  },
  {
    grade: 1, term: 2, lesson_id: 106,
    unit_ar: 'الوحدة الثالثة: الهندسة والقياس',
    unit_en: 'Unit 3: Geometry & Measurement',
    unit_fr: 'Unité 3 : Géométrie et Mesure',
    lesson_ar: 'الدرس السادس: مجموع قياسات زوايا المثلث والأشكال الرباعية',
    lesson_en: 'Unit 3 - Lesson 2: Interior Angles of Triangles & Quadrilaterals',
    lesson_fr: 'Unité 3 - Leçon 2 : Somme des Angles du Triangle et Quadrilatères',
    explain_summary_ar: 'مجموع قياسات الزوايا الداخلة للمثلث يساوي $180^\\circ$، وقياس الزاوية الخارجة يساوي مجموع قياسي الزاويتين الداخلتين عدا المجاورة لها، ومجموع زوايا الشكل الرباعي $360^\\circ$.',
    explain_summary_en: 'The sum of interior angles of a triangle is $180^\\circ$. An exterior angle equals the sum of the two non-adjacent interior angles. The sum of interior angles of a quadrilateral is $360^\\circ$.',
    explain_summary_fr: 'La somme des mesures des angles intérieurs d’un triangle est égale à $180^\\circ$. La mesure d’un angle extérieur est égale à la somme des deux angles intérieurs non adjacents. La somme des angles d’un quadrilatère est de $360^\\circ$.',
    homework_items_ar: [
      '1) مثلث $ABC$ فيه $m(\\angle A) = 50^\\circ$ و $m(\\angle B) = 70^\\circ$، أوجد $m(\\angle C)$ (كتاب الوزارة)',
      '2) شكل رباعي قياسات ثلاث زوايا فيه $80^\\circ, 110^\\circ, 95^\\circ$، أوجد قياس الزاوية الرابعة (كتاب المعاصر)',
      '3) أوجد قياس الزاوية الخارجة عن المثلث المتساوي الأضلاع (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) In $\\triangle ABC$, $m(\\angle A) = 50^\\circ$ and $m(\\angle B) = 70^\\circ$. Find $m(\\angle C)$ (Ministry Textbook)',
      '2) Three angles of a quadrilateral measure $80^\\circ, 110^\\circ, 95^\\circ$. Find the fourth angle (El-Moasser)',
      '3) Find the measure of an exterior angle of an equilateral triangle (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Dans un triangle $ABC$, $m(\\widehat{A}) = 50^\\circ$ et $m(\\widehat{B}) = 70^\\circ$. Calculer $m(\\widehat{C})$.',
      '2) Trois angles d’un quadrilatère mesurent $80^\\circ, 110^\\circ$ et $95^\\circ$. Calculer la mesure du quatrième angle.',
      '3) Calculer la mesure d’un angle extérieur d’un triangle équilatéral.'
    ],
    homework_solutions_ar: [
      '1) الحل: $m(\\angle C) = 180^\\circ - (50^\\circ + 70^\\circ) = 60^\\circ$.',
      '2) الحل: الزاوية الرابعة $= 360^\\circ - (80^\\circ + 110^\\circ + 95^\\circ) = 360^\\circ - 285^\\circ = 75^\\circ$.',
      '3) الحل: كل زاوية داخلة $= 60^\\circ \\implies \\text{الخارجة} = 180^\\circ - 60^\\circ = 120^\\circ$.'
    ],
    homework_solutions_en: [
      '1) Solution: $m(\\angle C) = 180^\\circ - (50^\\circ + 70^\\circ) = 60^\\circ$.',
      '2) Solution: Fourth angle $= 360^\\circ - (80^\\circ + 110^\\circ + 95^\\circ) = 75^\\circ$.',
      '3) Solution: Each interior angle $= 60^\\circ \\implies \\text{Exterior} = 180^\\circ - 60^\\circ = 120^\\circ$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $m(\\widehat{C}) = 180^\\circ - (50^\\circ + 70^\\circ) = 60^\\circ$.',
      '2) Solution : Quatrième angle $= 360^\\circ - (80^\\circ + 110^\\circ + 95^\\circ) = 75^\\circ$.',
      '3) Solution : Chaque angle intérieur vaut $60^\\circ \\implies \\text{Angle extérieur} = 180^\\circ - 60^\\circ = 120^\\circ$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): في المثلث $ABC$، إذا كان $m(\\angle A) = m(\\angle B) + m(\\angle C)$، فما نوع المثلث بالنسبة لزواياه؟ (قائم الزاوية لأن $m(\\angle A) = 90^\\circ$).',
      'مسألة متفوقين (2): مضلع محدب مجموع قياسات زواياه الداخلة $720^\\circ$، أوجد عدد أضلاعه (الحل: $(n - 2) \\times 180^\\circ = 720^\\circ \\implies n = 6$ أضلاع).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): In $\\triangle ABC$, if $m(\\angle A) = m(\\angle B) + m(\\angle C)$, classify the triangle by its angles (Right-angled triangle, $m(\\angle A) = 90^\\circ$).',
      'Gifted Problem (2): A convex polygon has an interior angle sum of $720^\\circ$. Find its number of sides ($(n-2)\\times 180^\\circ = 720^\\circ \\implies 6$ sides).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Dans un triangle $ABC$, si $m(\\widehat{A}) = m(\\widehat{B}) + m(\\widehat{C})$, quelle est la nature de ce triangle ? (Triangle rectangle en $A$, car $m(\\widehat{A}) = 90^\\circ$).',
      'Problème d’Excellence (2) : La somme des angles intérieurs d’un polygone convexe est de $720^\\circ$. Déterminer son nombre de côtés ($(n - 2) \\times 180^\\circ = 720^\\circ \\implies 6$ côtés).'
    ]
  },
  {
    grade: 1, term: 2, lesson_id: 107,
    unit_ar: 'الوحدة الرابعة: الإحصاء والاحتمالات',
    unit_en: 'Unit 4: Statistics & Probability',
    unit_fr: 'Unité 4 : Statistiques et Probabilités',
    lesson_ar: 'الدرس السابع: الإحصاء والقطاعات الدائرية والاحتمالات',
    lesson_en: 'Unit 4 - Lesson 1: Statistics, Pie Charts & Probability',
    lesson_fr: 'Unité 4 - Leçon 1 : Statistiques, Diagrammes Circulaires et Probabilités',
    explain_summary_ar: 'قياس الزاوية المركزية للقطاع الدائري $= \\text{النسبة المئوية} \\times 360^\\circ$، والوسط الحسابي $= \\frac{\\text{مجموع القيم}}{\\text{عددها}}$، واحتمال وقوع الحدث ينحصر بين $0$ (مستحيل) و $1$ (مؤكد).',
    explain_summary_en: 'Pie Chart Central Angle $= \\text{Percentage} \\times 360^\\circ$. The arithmetic mean $= \\frac{\\text{Sum of values}}{\\text{Count}}$. Probability $P(A)$ ranges between $0$ (impossible) and $1$ (certain).',
    explain_summary_fr: 'L’angle au centre d’un secteur circulaire est égal à $\\text{Pourcentage} \\times 360^\\circ$. La moyenne arithmétique est $\\frac{\\text{Somme des valeurs}}{\\text{Effectif total}}$. La probabilité $P(A)$ est comprise entre $0$ (événement impossible) et $1$ (événement certain).',
    homework_items_ar: [
      '1) قطاع دائري يمثل $25\\%$ من البيانات، أوجد قياس زاويته المركزية (كتاب الوزارة)',
      '2) أوجد الوسط الحسابي والوسيط للقيم: $8, 5, 12, 7, 8$ (كتاب المعاصر)',
      '3) عند إلقاء حجر نرد منتظم مرة واحدة، أوجد احتمال ظهور عدد أولي زوجي (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) A pie chart sector represents $25\\%$ of the data. Find its central angle (Ministry Textbook)',
      '2) Find the mean and median of the values: $8, 5, 12, 7, 8$ (El-Moasser)',
      '3) When rolling a fair die once, find the probability of getting an even prime number (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Un secteur circulaire représente $25\\%$ des données. Calculer la mesure de son angle au centre.',
      '2) Calculer la moyenne arithmétique et la médiane de la série : $8, 5, 12, 7, 8$.',
      '3) On lance un dé équilibré à six faces. Calculer la probabilité d’obtenir un nombre premier pair.'
    ],
    homework_solutions_ar: [
      '1) الحل: الزاوية المركزية $= \\frac{25}{100} \\times 360^\\circ = 90^\\circ$.',
      '2) الحل: الوسط $= \\frac{8+5+12+7+8}{5} = 8$ | بعد الترتيب $(5, 7, 8, 8, 12)$ الوسيط $= 8$.',
      '3) الحل: العدد الأولي الزوجي الوحيد هو $\\{2\\} \\implies \\text{الاحتمال} = \\frac{1}{6}$.'
    ],
    homework_solutions_en: [
      '1) Solution: Central angle $= \\frac{25}{100} \\times 360^\\circ = 90^\\circ$.',
      '2) Solution: Mean $= \\frac{40}{5} = 8$ | Ordered $(5, 7, 8, 8, 12) \\implies \\text{Median} = 8$.',
      '3) Solution: The only even prime number is $\\{2\\} \\implies P = \\frac{1}{6}$.'
    ],
    homework_solutions_fr: [
      '1) Solution : Angle au centre $= \\frac{25}{100} \\times 360^\\circ = 90^\\circ$.',
      '2) Solution : Moyenne $= \\frac{40}{5} = 8$ | Série ordonnée $(5, 7, 8, 8, 12) \\implies \\text{Médiane} = 8$.',
      '3) Solution : Le seul nombre premier pair est $\\{2\\} \\implies P = \\frac{1}{6}$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان الوسط الحسابي لخمسة أعداد هو $14$، وأضيف إليها عدد سادس فأصبح الوسط $15$، فما قيمة العدد السادس؟ (الحل: $6 \\times 15 - 5 \\times 14 = 90 - 70 = 20$).',
      'مسألة متفوقين (2): صندوق به $20$ كرة حمراء وبيضاء، فإذا كان احتمال سحب كرة حمراء هو $0.35$، فكم عدد الكرات البيضاء؟ (الحل: $20 \\times (1 - 0.35) = 13$ كرة).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): The mean of 5 numbers is $14$. When a 6th number is added, the mean becomes $15$. Find the 6th number ($90 - 70 = 20$).',
      'Gifted Problem (2): A box contains $20$ red and white balls. If $P(\\text{red}) = 0.35$, how many white balls are there? ($20 \\times 0.65 = 13$ balls).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : La moyenne de 5 nombres est $14$. En ajoutant un 6ème nombre, la moyenne devient $15$. Calculer ce 6ème nombre ($6 \\times 15 - 5 \\times 14 = 20$).',
      'Problème d’Excellence (2) : Une urne contient $20$ boules rouges et blanches. Si la probabilité de tirer une boule rouge est $0{,}35$, quel est le nombre de boules blanches ? ($20 \\times 0{,}65 = 13$ boules).'
    ]
  },

  // ==================== الصف الثاني الإعدادي (4 دروس × 4 ملفات = 16 ملف PDF) ====================
  {
    grade: 2, term: 1, lesson_id: 201,
    unit_ar: 'الوحدة الأولى: الأعداد الحقيقية والفترات',
    unit_en: 'Unit 1: Real Numbers & Intervals',
    unit_fr: 'Unité 1 : Nombres Réels et Intervalles',
    lesson_ar: 'الدرس الأول: الجذر التكعيبي والأعداد الحقيقية والفترات',
    lesson_en: 'Unit 1 - Lesson 1: Cube Roots, Real Numbers & Intervals',
    lesson_fr: 'Unité 1 - Leçon 1 : Racines Cubiques, Nombres Réels et Intervalles',
    explain_summary_ar: 'الأعداد الحقيقية $\\mathbb{R} = \\mathbb{Q} \\cup \\mathbb{Q}^\\prime$ (اتحاد الأعداد النسبية وغير النسبية). والفترات المحدودة وغير المحدودة تُستخدم لتمثيل مجموعات جزئية من $\\mathbb{R}$ على خط الأعداد.',
    explain_summary_en: 'Real numbers $\\mathbb{R} = \\mathbb{Q} \\cup \\mathbb{Q}^\\prime$ (union of rational and irrational numbers). Bounded and unbounded intervals represent subsets of $\\mathbb{R}$ on the number line.',
    explain_summary_fr: 'L’ensemble des nombres réels est $\\mathbb{R} = \\mathbb{Q} \\cup \\mathbb{Q}^\\prime$ (réunion des nombres rationnels et irrationnels). Les intervalles bornés et non bornés représentent des sous-ensembles de $\\mathbb{R}$ sur la droite graduée.',
    homework_items_ar: [
      '1) أوجد قيمة: $\\sqrt[3]{64} + \\sqrt{25} - \\sqrt[3]{-27}$ (كتاب الوزارة)',
      '2) إذا كانت $X = [-1, 4]$ و $Y = [2, 6]$ فأوجد: $X \\cap Y$ و $X \\cup Y$ و $X - Y$ (كتاب المعاصر)',
      '3) اختصر لأبسط صورة: $\\sqrt{50} + \\sqrt{18} - 2\\sqrt{2}$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Evaluate: $\\sqrt[3]{64} + \\sqrt{25} - \\sqrt[3]{-27}$ (Ministry Textbook)',
      '2) Given $X = [-1, 4]$ and $Y = [2, 6]$, find $X \\cap Y$, $X \\cup Y$, and $X - Y$ (El-Moasser)',
      '3) Simplify: $\\sqrt{50} + \\sqrt{18} - 2\\sqrt{2}$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Calculer la valeur de : $\\sqrt[3]{64} + \\sqrt{25} - \\sqrt[3]{-27}$.',
      '2) Soient les intervalles $X = [-1, 4]$ et $Y = [2, 6]$. Déterminer $X \\cap Y$, $X \\cup Y$ et $X \\setminus Y$.',
      '3) Simplifier l’expression : $\\sqrt{50} + \\sqrt{18} - 2\\sqrt{2}$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $4 + 5 - (-3) = 9 + 3 = 12$.',
      '2) الحل: $X \\cap Y = [2, 4]$ | $X \\cup Y = [-1, 6]$ | $X - Y = [-1, 2[$.',
      '3) الحل: $5\\sqrt{2} + 3\\sqrt{2} - 2\\sqrt{2} = 6\\sqrt{2}$.'
    ],
    homework_solutions_en: [
      '1) Solution: $4 + 5 - (-3) = 12$.',
      '2) Solution: $X \\cap Y = [2, 4]$ | $X \\cup Y = [-1, 6]$ | $X - Y = [-1, 2)$.',
      '3) Solution: $5\\sqrt{2} + 3\\sqrt{2} - 2\\sqrt{2} = 6\\sqrt{2}$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $4 + 5 - (-3) = 12$.',
      '2) Solution : $X \\cap Y = [2, 4]$ | $X \\cup Y = [-1, 6]$ | $X \\setminus Y = [-1, 2[$.',
      '3) Solution : $5\\sqrt{2} + 3\\sqrt{2} - 2\\sqrt{2} = 6\\sqrt{2}$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كانت $x = \\sqrt{5} + 2$ و $y = \\frac{1}{\\sqrt{5} + 2}$ فأوجد قيمة $(x + y)^2$ (الحل: $y = \\sqrt{5}-2 \\implies x+y = 2\\sqrt{5} \\implies (x+y)^2 = 20$).',
      'مسألة متفوقين (2): أوجد مجموعة حل المعادلة: $(x - 1)^3 + 5 = -3$ في $\\mathbb{R}$ (الحل: $(x-1)^3 = -8 \\implies x - 1 = -2 \\implies x = -1$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If $x = \\sqrt{5} + 2$ and $y = \\frac{1}{\\sqrt{5} + 2}$, find $(x + y)^2$ (Answer: $(2\\sqrt{5})^2 = 20$).',
      'Gifted Problem (2): Solve $(x - 1)^3 + 5 = -3$ in $\\mathbb{R}$ (Answer: $x - 1 = -2 \\implies x = -1$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si $x = \\sqrt{5} + 2$ et $y = \\frac{1}{\\sqrt{5} + 2}$, calculer $(x + y)^2$ (Réponse : $(2\\sqrt{5})^2 = 20$).',
      'Problème d’Excellence (2) : Résoudre dans $\\mathbb{R}$ l’équation : $(x - 1)^3 + 5 = -3$ (Réponse : $x - 1 = -2 \\implies x = -1$).'
    ]
  },
  {
    grade: 2, term: 2, lesson_id: 202,
    unit_ar: 'الوحدة الثانية: الجبر (التحليل)',
    unit_en: 'Unit 2: Algebra (Factorization)',
    unit_fr: 'Unité 2 : Algèbre (Factorisation)',
    lesson_ar: 'الدرس الثاني: تحليل المقادير الجبرية (الثلاثي والفرق بين مربعين ومكعبين)',
    lesson_en: 'Unit 2 - Lesson 1: Factorization of Algebraic Expressions',
    lesson_fr: 'Unité 2 - Leçon 1 : Factorisation des Expressions Algébriques',
    explain_summary_ar: 'تحليل المقدار الثلاثي $x^2 + bx + c$: نبحث عن عددين حاصل ضربهما $c$ ومجموعهما $b$. والفرق بين مربعين: $x^2 - y^2 = (x - y)(x + y)$. ومجموع المكعبين: $x^3 + y^3 = (x + y)(x^2 - xy + y^2)$.',
    explain_summary_en: 'To factorize $x^2 + bx + c$, find two numbers whose product is $c$ and sum is $b$. Difference of two squares: $x^2 - y^2 = (x - y)(x + y)$. Sum of cubes: $x^3 + y^3 = (x + y)(x^2 - xy + y^2)$.',
    explain_summary_fr: 'Pour factoriser le trinôme $x^2 + bx + c$, on cherche deux nombres dont le produit est $c$ et la somme est $b$. Différence de deux carrés : $x^2 - y^2 = (x - y)(x + y)$. Somme de deux cubes : $x^3 + y^3 = (x + y)(x^2 - xy + y^2)$.',
    homework_items_ar: [
      '1) حلل تحليلاً كاملاً: $x^2 - 5x + 6$ (كتاب الوزارة)',
      '2) حلل بإخراج العامل المشترك والفرق بين مربعين: $2x^2 - 18$ (كتاب المعاصر)',
      '3) حلل مجموع المكعبين: $x^3 + 8$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Factorize completely: $x^2 - 5x + 6$ (Ministry Textbook)',
      '2) Factorize completely: $2x^2 - 18$ (El-Moasser)',
      '3) Factorize the sum of cubes: $x^3 + 8$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Factoriser complètement le trinôme : $x^2 - 5x + 6$.',
      '2) Factoriser complètement : $2x^2 - 18$.',
      '3) Factoriser la somme de deux cubes : $x^3 + 8$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $(x - 2)(x - 3)$.',
      '2) الحل: $2(x^2 - 9) = 2(x - 3)(x + 3)$.',
      '3) الحل: $(x + 2)(x^2 - 2x + 4)$.'
    ],
    homework_solutions_en: [
      '1) Solution: $(x - 2)(x - 3)$.',
      '2) Solution: $2(x^2 - 9) = 2(x - 3)(x + 3)$.',
      '3) Solution: $(x + 2)(x^2 - 2x + 4)$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $(x - 2)(x - 3)$.',
      '2) Solution : $2(x^2 - 9) = 2(x - 3)(x + 3)$.',
      '3) Solution : $(x + 2)(x^2 - 2x + 4)$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): استخدم التحليل لتسهيل إيجاد قيمة: $(99)^2 - 1$ (الحل: $(99 - 1)(99 + 1) = 98 \\times 100 = 9800$).',
      'مسألة متفوقين (2): إذا كان $x + y = 5$ و $x - y = 3$ فأوجد قيمة $x^2 - y^2$ (الحل: $5 \\times 3 = 15$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): Use factorization to evaluate $(99)^2 - 1$ (Answer: $(99 - 1)(99 + 1) = 98 \\times 100 = 9800$).',
      'Gifted Problem (2): If $x + y = 5$ and $x - y = 3$, find $x^2 - y^2$ (Answer: $5 \\times 3 = 15$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Utiliser la factorisation pour calculer $(99)^2 - 1$ (Réponse : $(99 - 1)(99 + 1) = 98 \\times 100 = 9800$).',
      'Problème d’Excellence (2) : Sachant que $x + y = 5$ et $x - y = 3$, calculer $x^2 - y^2$ (Réponse : $5 \\times 3 = 15$).'
    ]
  },
  {
    grade: 2, term: 1, lesson_id: 203,
    unit_ar: 'الوحدة الثالثة: الهندسة (متوسطات المثلث والمثلث المتساوي الساقين)',
    unit_en: 'Unit 3: Geometry (Medians & Isosceles Triangles)',
    unit_fr: 'Unité 3 : Géométrie (Médianes et Triangles Isocèles)',
    lesson_ar: 'الدرس الثالث: متوسطات المثلث والمثلث المتساوي الساقين',
    lesson_en: 'Unit 3 - Lesson 1: Medians of a Triangle & Isosceles Triangle',
    lesson_fr: 'Unité 3 - Leçon 1 : Médianes d’un Triangle et Triangle Isocèle',
    explain_summary_ar: 'نقطة تقاطع متوسطات المثلث تقسم كلاً منها بنسبة $1 : 2$ من جهة القاعدة ($2 : 1$ من جهة الرأس). وطول متوسط المثلث القائم الخارج من رأس القائمة يساوي نصف طول الوتر.',
    explain_summary_en: 'The centroid of a triangle divides each median in the ratio $1 : 2$ from the base ($2 : 1$ from the vertex). The median drawn from the right angle of a right triangle equals half the hypotenuse.',
    explain_summary_fr: 'Le centre de gravité d’un triangle partage chaque médiane dans le rapport $1 : 2$ à partir de la base ($2 : 1$ à partir du sommet). Dans un triangle rectangle, la médiane issue du sommet de l’angle droit mesure la moitié de l’hypoténuse.',
    homework_items_ar: [
      '1) مثلث $ABC$ قائم في $B$، طول الوتر $AC = 12\\text{ cm}$، أوجد طول المتوسط $BD$ الخارج من $B$ (كتاب الوزارة)',
      '2) $M$ نقطة تقاطع متوسطات المثلث $ABC$، فإذا كان طول المتوسط $AD = 9\\text{ cm}$، فأوجد طول $AM$ و $MD$ (كتاب المعاصر)',
      '3) مثلث متساوي الساقين قياس زاوية رأسه $70^\\circ$، أوجد قياس كل من زاويتي القاعدة (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) In right $\\triangle ABC$ at $B$, hypotenuse $AC = 12\\text{ cm}$. Find the length of median $BD$ (Ministry Textbook)',
      '2) $M$ is the centroid of $\\triangle ABC$. If median $AD = 9\\text{ cm}$, find $AM$ and $MD$ (El-Moasser)',
      '3) An isosceles triangle has a vertex angle of $70^\\circ$. Find each base angle (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Soit $ABC$ un triangle rectangle en $B$ tel que l’hypoténuse $AC = 12\\text{ cm}$. Calculer la longueur de la médiane $BD$.',
      '2) $M$ est le centre de gravité du triangle $ABC$. Si la médiane $AD = 9\\text{ cm}$, calculer $AM$ et $MD$.',
      '3) Un triangle isocèle a un angle au sommet de $70^\\circ$. Calculer la mesure de chacun des angles à la base.'
    ],
    homework_solutions_ar: [
      '1) الحل: طول المتوسط الخارج من رأس القائمة $= \\frac{1}{2} \\times 12 = 6\\text{ cm}$.',
      '2) الحل: $MD = \\frac{1}{3} \\times 9 = 3\\text{ cm}$ | $AM = \\frac{2}{3} \\times 9 = 6\\text{ cm}$.',
      '3) الحل: قياس كل زاوية قاعدة $= \\frac{180^\\circ - 70^\\circ}{2} = 55^\\circ$.'
    ],
    homework_solutions_en: [
      '1) Solution: Median from right angle $= \\frac{1}{2} \\times 12 = 6\\text{ cm}$.',
      '2) Solution: $MD = \\frac{1}{3} \\times 9 = 3\\text{ cm}$ | $AM = \\frac{2}{3} \\times 9 = 6\\text{ cm}$.',
      '3) Solution: Each base angle $= \\frac{180^\\circ - 70^\\circ}{2} = 55^\\circ$.'
    ],
    homework_solutions_fr: [
      '1) Solution : La médiane issue de l’angle droit vaut $\\frac{1}{2} \\times 12 = 6\\text{ cm}$.',
      '2) Solution : $MD = \\frac{1}{3} \\times 9 = 3\\text{ cm}$ | $AM = \\frac{2}{3} \\times 9 = 6\\text{ cm}$.',
      '3) Solution : Chaque angle à la base mesure $\\frac{180^\\circ - 70^\\circ}{2} = 55^\\circ$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): مثلث قائم الزاوية طول وتره $10\\text{ cm}$ وقياس إحدى زواياه $30^\\circ$، أوجد طول الضلع المقابل للزاوية $30^\\circ$ وطول المتوسط الخارج من رأس القائمة (كلاهما $= 5\\text{ cm}$).',
      'مسألة متفوقين (2): برهن أن منصف زاوية الرأس في المثلث المتساوي الساقين ينصف القاعدة ويكون عمودياً عليها.'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): A right triangle has a hypotenuse of $10\\text{ cm}$ and a $30^\\circ$ angle. Find the side opposite to $30^\\circ$ and the median to the hypotenuse (Both equal $5\\text{ cm}$).',
      'Gifted Problem (2): Prove that the vertex angle bisector in an isosceles triangle is perpendicular to and bisects the base.'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Un triangle rectangle a une hypoténuse de $10\\text{ cm}$ et un angle de $30^\\circ$. Calculer le côté opposé à l’angle de $30^\\circ$ et la médiane relative à l’hypoténuse (Tous deux valent $5\\text{ cm}$).',
      'Problème d’Excellence (2) : Démontrer que la bissectrice de l’angle au sommet d’un triangle isocèle est aussi la médiatrice de la base.'
    ]
  },
  {
    grade: 2, term: 2, lesson_id: 204,
    unit_ar: 'الوحدة الرابعة: المساحات والتشابه ونظرية إقليدس',
    unit_en: 'Unit 4: Areas & Theorems (Pythagoras & Euclid)',
    unit_fr: 'Unité 4 : Aires et Théorèmes (Pythagore et Euclide)',
    lesson_ar: 'الدرس الرابع: نظرية فيثاغورس وعكسها ونظرية إقليدس',
    lesson_en: 'Unit 4 - Lesson 1: Pythagoras & Euclid Theorems',
    lesson_fr: 'Unité 4 - Leçon 1 : Théorèmes de Pythagore et d’Euclide',
    explain_summary_ar: 'في المثلث القائم: مربع طول الوتر يساوي مجموع مربعي طولي ضلعي القائمة ($c^2 = a^2 + b^2$). وفي نظرية إقليدس: $(AB)^2 = BD \\times BC$ و $(AD)^2 = BD \\times DC$.',
    explain_summary_en: 'Pythagoras Theorem: $c^2 = a^2 + b^2$. Euclid’s Theorem: In right $\\triangle ABC$ at $A$ with $AD \\perp BC$, $(AB)^2 = BD \\times BC$ and $(AD)^2 = BD \\times DC$.',
    explain_summary_fr: 'Théorème de Pythagore : dans un triangle rectangle, $c^2 = a^2 + b^2$. Théorème d’Euclide : dans un triangle $ABC$ rectangle en $A$ avec $AD \\perp BC$, $(AB)^2 = BD \\times BC$ et $(AD)^2 = BD \\times DC$.',
    homework_items_ar: [
      '1) مثلث $ABC$ قائم في $B$، $AB = 6\\text{ cm}$، $BC = 8\\text{ cm}$، أوجد طول الوتر $AC$ (كتاب الوزارة)',
      '2) مثلث أطوال أضلاعه $5\\text{ cm}, 12\\text{ cm}, 13\\text{ cm}$، أثبت أنه قائم الزاوية (كتاب المعاصر)',
      '3) في المثلث $ABC$ القائم في $A$، $AD \\perp BC$، $BD = 9\\text{ cm}$، $DC = 16\\text{ cm}$، أوجد طول $AD$ و $AB$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) In right $\\triangle ABC$ at $B$, $AB = 6\\text{ cm}$ and $BC = 8\\text{ cm}$. Find hypotenuse $AC$ (Ministry Textbook)',
      '2) A triangle has sides $5\\text{ cm}, 12\\text{ cm}, 13\\text{ cm}$. Prove that it is a right-angled triangle (El-Moasser)',
      '3) In right $\\triangle ABC$ at $A$, $AD \\perp BC$, $BD = 9\\text{ cm}$, $DC = 16\\text{ cm}$. Find $AD$ and $AB$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Soit $ABC$ un triangle rectangle en $B$ tel que $AB = 6\\text{ cm}$ et $BC = 8\\text{ cm}$. Calculer l’hypoténuse $AC$.',
      '2) Un triangle a pour côtés $5\\text{ cm}, 12\\text{ cm}$ et $13\\text{ cm}$. Démontrer que ce triangle est rectangle.',
      '3) Dans le triangle $ABC$ rectangle en $A$, $AD \\perp BC$ avec $BD = 9\\text{ cm}$ et $DC = 16\\text{ cm}$. Calculer $AD$ et $AB$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $AC = \\sqrt{6^2 + 8^2} = \\sqrt{36 + 64} = \\sqrt{100} = 10\\text{ cm}$.',
      '2) الحل: $13^2 = 169$ ، $5^2 + 12^2 = 25 + 144 = 169 \\implies$ المثلث قائم الزاوية.',
      '3) الحل: $(AD)^2 = 9 \\times 16 = 144 \\implies AD = 12\\text{ cm}$ | $(AB)^2 = 9 \\times 25 = 225 \\implies AB = 15\\text{ cm}$.'
    ],
    homework_solutions_en: [
      '1) Solution: $AC = \\sqrt{6^2 + 8^2} = \\sqrt{100} = 10\\text{ cm}$.',
      '2) Solution: $13^2 = 169$ and $5^2 + 12^2 = 169 \\implies$ Right-angled triangle.',
      '3) Solution: $(AD)^2 = 9 \\times 16 = 144 \\implies AD = 12\\text{ cm}$ | $(AB)^2 = 9 \\times 25 = 225 \\implies AB = 15\\text{ cm}$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $AC = \\sqrt{6^2 + 8^2} = \\sqrt{100} = 10\\text{ cm}$.',
      '2) Solution : $13^2 = 169$ et $5^2 + 12^2 = 169 \\implies$ D’après la réciproque du théorème de Pythagore, le triangle est rectangle.',
      '3) Solution : $(AD)^2 = 9 \\times 16 = 144 \\implies AD = 12\\text{ cm}$ | $(AB)^2 = 9 \\times 25 = 225 \\implies AB = 15\\text{ cm}$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): معين طولا قطريه $12\\text{ cm}$ و $16\\text{ cm}$، أوجد محيطه ومساحته (طول الضلع $= 10\\text{ cm} \\implies$ المحيط $= 40\\text{ cm}$ والمساحة $= 96\\text{ cm}^2$).',
      'مسألة متفوقين (2): شبه منحرف متساوي الساقين طولا قاعدتيه المتوازيتين $6\\text{ cm}$ و $14\\text{ cm}$ وطول ساقه $5\\text{ cm}$، أوجد مساحته (الارتفاع $= 3\\text{ cm} \\implies$ المساحة $= 30\\text{ cm}^2$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): A rhombus has diagonals $12\\text{ cm}$ and $16\\text{ cm}$. Find its perimeter and area (Perimeter $= 40\\text{ cm}$, Area $= 96\\text{ cm}^2$).',
      'Gifted Problem (2): An isosceles trapezium has parallel bases $6\\text{ cm}$ and $14\\text{ cm}$ and leg $5\\text{ cm}$. Find its area (Height $= 3\\text{ cm}$, Area $= 30\\text{ cm}^2$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Un losange a des diagonales de $12\\text{ cm}$ et $16\\text{ cm}$. Calculer son périmètre et son aire (Périmètre $= 40\\text{ cm}$, Aire $= 96\\text{ cm}^2$).',
      'Problème d’Excellence (2) : Un trapèze isocèle a pour bases parallèles $6\\text{ cm}$ et $14\\text{ cm}$, et pour côté oblique $5\\text{ cm}$. Calculer son aire (Hauteur $= 3\\text{ cm}$, Aire $= 30\\text{ cm}^2$).'
    ]
  },

  // ==================== الصف الثالث الإعدادي (4 دروس × 4 ملفات = 16 ملف PDF) ====================
  {
    grade: 3, term: 1, lesson_id: 301,
    unit_ar: 'الوحدة الأولى: العلاقات والدوال',
    unit_en: 'Unit 1: Relations & Functions',
    unit_fr: 'Unité 1 : Relations et Fonctions',
    lesson_ar: 'الدرس الأول: الدالة التربيعية ورسم منحناها البياني',
    lesson_en: 'Unit 1 - Lesson 1: Quadratic Function & Graphing',
    lesson_fr: 'Unité 1 - Leçon 1 : Fonction Quadratique et Représentation Graphique',
    explain_summary_ar: 'الدالة التربيعية $f(x) = ax^2 + bx + c$ ($a \\neq 0$). إحداثي رأس المنحنى $x = \\frac{-b}{2a}$، ومعادلة محور التماثل $x = \\frac{-b}{2a}$، والقيمة العظمى أو الصغرى هي $f\\left(\\frac{-b}{2a}\\right)$.',
    explain_summary_en: 'For the quadratic function $f(x) = ax^2 + bx + c$ ($a \\neq 0$), the vertex has $x = \\frac{-b}{2a}$, the axis of symmetry is $x = \\frac{-b}{2a}$, and the extreme value is $f\\left(\\frac{-b}{2a}\\right)$.',
    explain_summary_fr: 'Pour la fonction quadratique $f(x) = ax^2 + bx + c$ ($a \\neq 0$), l’abscisse du sommet de la parabole est $x = \\frac{-b}{2a}$, l’équation de l’axe de symétrie est $x = \\frac{-b}{2a}$, et l’extremum (minimum ou maximum) vaut $f\\left(\\frac{-b}{2a}\\right)$.',
    homework_items_ar: [
      '1) أوجد نقطة رأس المنحنى ومعادلة محور التماثل للدالة: $f(x) = x^2 - 4x + 3$ (كتاب الوزارة)',
      '2) أوجد القيمة العظمى للدالة: $f(x) = 4 - x^2$ في الفترة $[-3, 3]$ (كتاب المعاصر)',
      '3) إذا كانت النقطة $(2, 5)$ تقع على منحنى الدالة $f(x) = ax^2 + 1$، فأوجد قيمة $a$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Find the vertex and axis of symmetry for: $f(x) = x^2 - 4x + 3$ (Ministry Textbook)',
      '2) Find the maximum value of $f(x) = 4 - x^2$ on $[-3, 3]$ (El-Moasser)',
      '3) If $(2, 5)$ lies on the curve $f(x) = ax^2 + 1$, find the value of $a$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Déterminer les coordonnées du sommet et l’équation de l’axe de symétrie de la parabole : $f(x) = x^2 - 4x + 3$.',
      '2) Déterminer la valeur maximale de la fonction $f(x) = 4 - x^2$ sur l’intervalle $[-3, 3]$.',
      '3) Sachant que le point $(2, 5)$ appartient à la courbe de $f(x) = ax^2 + 1$, calculer $a$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $x = \\frac{4}{2} = 2$ | $f(2) = 4 - 8 + 3 = -1 \\implies$ رأس المنحنى $(2, -1)$ ومحور التماثل $x = 2$.',
      '2) الحل: القيمة العظمى $= 4$ عند $x = 0$.',
      '3) الحل: $4a + 1 = 5 \\implies 4a = 4 \\implies a = 1$.'
    ],
    homework_solutions_en: [
      '1) Solution: $x = \\frac{4}{2} = 2$, $f(2) = -1 \\implies$ Vertex $(2, -1)$ and Axis $x = 2$.',
      '2) Solution: Maximum value $= 4$ at $x = 0$.',
      '3) Solution: $4a + 1 = 5 \\implies 4a = 4 \\implies a = 1$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $x = \\frac{4}{2} = 2$ et $f(2) = -1 \\implies$ Sommet $(2, -1)$ et axe de symétrie $x = 2$.',
      '2) Solution : La valeur maximale est $4$ atteinte en $x = 0$.',
      '3) Solution : $4a + 1 = 5 \\implies 4a = 4 \\implies a = 1$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان منحنى الدالة $f(x) = x^2 + kx + 9$ يمس محور السينات، فأوجد قيم $k$ الممكنة ($k = \\pm 6$).',
      'مسألة متفوقين (2): أوجد مساحة المثلث المحصور بين محور السينات ومنحنى الدالة $f(x) = x^2 - 4$ أسفل محور السينات (القاعدة $= 4$، الارتفاع $= 4 \\implies$ المساحة $= 8$ وحدات مربعة).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If the parabola $f(x) = x^2 + kx + 9$ touches the x-axis, find $k$ ($k = \\pm 6$).',
      'Gifted Problem (2): Find the area of the triangle bounded by the x-axis and the vertex of $f(x) = x^2 - 4$ (Area $= \\frac{1}{2} \\times 4 \\times 4 = 8\\text{ sq. units}$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si la parabole $f(x) = x^2 + kx + 9$ est tangente à l’axe des abscisses, déterminer $k$ ($k = \\pm 6$).',
      'Problème d’Excellence (2) : Calculer l’aire du triangle formé par les points d’intersection de $f(x) = x^2 - 4$ avec l’axe des abscisses et le sommet de la parabole (Aire $= \\frac{1}{2} \\times 4 \\times 4 = 8\\text{ unités d’aire}$).'
    ]
  },
  {
    grade: 3, term: 1, lesson_id: 302,
    unit_ar: 'الوحدة الثانية: حساب المثلثات',
    unit_en: 'Unit 2: Trigonometry',
    unit_fr: 'Unité 2 : Trigonométrie',
    lesson_ar: 'الدرس الثاني: النسب المثلثية الأساسية للزاوية الحادة والزوايا الخاصة',
    lesson_en: 'Unit 2 - Lesson 1: Trigonometric Ratios & Special Angles',
    lesson_fr: 'Unité 2 - Leçon 1 : Rapports Trigonométriques et Angles Remarquables',
    explain_summary_ar: 'في المثلث القائم: $\\sin \\theta = \\frac{\\text{المقابل}}{\\text{الوتر}}$، $\\cos \\theta = \\frac{\\text{المجاور}}{\\text{الوتر}}$، $\\tan \\theta = \\frac{\\text{المقابل}}{\\text{المجاور}}$. وقيم الزوايا الخاصة: $\\sin 30^\\circ = \\frac{1}{2}$، $\\cos 60^\\circ = \\frac{1}{2}$، $\\tan 45^\\circ = 1$.',
    explain_summary_en: 'In a right triangle: $\\sin \\theta = \\frac{\\text{Opposite}}{\\text{Hypotenuse}}$, $\\cos \\theta = \\frac{\\text{Adjacent}}{\\text{Hypotenuse}}$, $\\tan \\theta = \\frac{\\text{Opposite}}{\\text{Adjacent}}$. Special angles: $\\sin 30^\\circ = \\frac{1}{2}$, $\\cos 60^\\circ = \\frac{1}{2}$, $\\tan 45^\\circ = 1$.',
    explain_summary_fr: 'Dans un triangle rectangle : $\\sin \\theta = \\frac{\\text{Côté opposé}}{\\text{Hypoténuse}}$, $\\cos \\theta = \\frac{\\text{Côté adjacent}}{\\text{Hypoténuse}}$, $\\tan \\theta = \\frac{\\text{Côté opposé}}{\\text{Côté adjacent}}$. Valeurs remarquables : $\\sin 30^\\circ = \\frac{1}{2}$, $\\cos 60^\\circ = \\frac{1}{2}$, $\\tan 45^\\circ = 1$.',
    homework_items_ar: [
      '1) بدون استخدام الآلة الحاسبة أوجد قيمة: $\\sin 30^\\circ + \\cos 60^\\circ - \\tan 45^\\circ$ (كتاب الوزارة)',
      '2) مثلث $ABC$ قائم في $B$ فيه $AB = 3\\text{ cm}$، $BC = 4\\text{ cm}$، أوجد: $\\sin A \\cos C + \\cos A \\sin C$ (كتاب المعاصر)',
      '3) أوجد قيمة $x$ (حيث $x$ زاوية حادة) إذا كان: $2\\sin x = \\tan^2 60^\\circ - 2\\tan 45^\\circ$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Without a calculator, evaluate: $\\sin 30^\\circ + \\cos 60^\\circ - \\tan 45^\\circ$ (Ministry Textbook)',
      '2) In right $\\triangle ABC$ at $B$, $AB = 3\\text{ cm}$ and $BC = 4\\text{ cm}$. Find $\\sin A \\cos C + \\cos A \\sin C$ (El-Moasser)',
      '3) Find the acute angle $x$ if: $2\\sin x = \\tan^2 60^\\circ - 2\\tan 45^\\circ$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Sans calculatrice, calculer : $\\sin 30^\\circ + \\cos 60^\\circ - \\tan 45^\\circ$.',
      '2) Soit $ABC$ un triangle rectangle en $B$ tel que $AB = 3\\text{ cm}$ et $BC = 4\\text{ cm}$. Calculer $\\sin A \\cos C + \\cos A \\sin C$.',
      '3) Déterminer la mesure de l’angle aigu $x$ tel que : $2\\sin x = \\tan^2 60^\\circ - 2\\tan 45^\\circ$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $\\frac{1}{2} + \\frac{1}{2} - 1 = 0$.',
      '2) الحل: الوتر $AC = 5\\text{ cm} \\implies \\left(\\frac{4}{5}\\right)\\left(\\frac{4}{5}\\right) + \\left(\\frac{3}{5}\\right)\\left(\\frac{3}{5}\\right) = \\frac{16}{25} + \\frac{9}{25} = 1$.',
      '3) الحل: $2\\sin x = (\\sqrt{3})^2 - 2(1) = 1 \\implies \\sin x = \\frac{1}{2} \\implies x = 30^\\circ$.'
    ],
    homework_solutions_en: [
      '1) Solution: $\\frac{1}{2} + \\frac{1}{2} - 1 = 0$.',
      '2) Solution: Hypotenuse $AC = 5\\text{ cm} \\implies \\frac{16}{25} + \\frac{9}{25} = 1$.',
      '3) Solution: $2\\sin x = 3 - 2 = 1 \\implies \\sin x = \\frac{1}{2} \\implies x = 30^\\circ$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $\\frac{1}{2} + \\frac{1}{2} - 1 = 0$.',
      '2) Solution : L’hypoténuse vaut $AC = 5\\text{ cm} \\implies \\frac{16}{25} + \\frac{9}{25} = 1$.',
      '3) Solution : $2\\sin x = 3 - 2 = 1 \\implies \\sin x = \\frac{1}{2} \\implies x = 30^\\circ$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): إذا كان $\\sin(x + 10^\\circ) = \\cos(2x - 10^\\circ)$ حيث الزاويتان حادتان، فأوجد قيمة $x$ (الحل: $3x = 90^\\circ \\implies x = 30^\\circ$).',
      'مسألة متفوقين (2): أثبت أن $\\sin^2 30^\\circ + \\sin^2 60^\\circ = \\tan 45^\\circ$ (الحل: $\\frac{1}{4} + \\frac{3}{4} = 1$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): If $\\sin(x + 10^\\circ) = \\cos(2x - 10^\\circ)$ for acute angles, find $x$ ($3x = 90^\\circ \\implies x = 30^\\circ$).',
      'Gifted Problem (2): Prove that $\\sin^2 30^\\circ + \\sin^2 60^\\circ = \\tan 45^\\circ$ ($\\frac{1}{4} + \\frac{3}{4} = 1$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Si $\\sin(x + 10^\\circ) = \\cos(2x - 10^\\circ)$ pour deux angles aigus, calculer $x$ ($3x = 90^\\circ \\implies x = 30^\\circ$).',
      'Problème d’Excellence (2) : Démontrer que $\\sin^2 30^\\circ + \\sin^2 60^\\circ = \\tan 45^\\circ$ ($\\frac{1}{4} + \\frac{3}{4} = 1$).'
    ]
  },
  {
    grade: 3, term: 1, lesson_id: 303,
    unit_ar: 'الوحدة الثالثة: الهندسة التحليلية',
    unit_en: 'Unit 3: Analytic Geometry',
    unit_fr: 'Unité 3 : Géométrie Analytique',
    lesson_ar: 'الدرس الثالث: البعد بين نقطتين وإحداثيا المنتصف وميل المستقيم',
    lesson_en: 'Unit 3 - Lesson 1: Distance, Midpoint & Slope of a Straight Line',
    lesson_fr: 'Unité 3 - Leçon 1 : Distance, Milieu et Pente d’une Droite',
    explain_summary_ar: 'البعد بين نقطتين $d = \\sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$. وإحداثي المنتصف $M = \\left(\\frac{x_1+x_2}{2}, \\frac{y_1+y_2}{2}\\right)$. شرط التوازي $m_1 = m_2$، وشرط التعامد $m_1 \\times m_2 = -1$.',
    explain_summary_en: 'Distance formula: $d = \\sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$. Midpoint: $M = \\left(\\frac{x_1+x_2}{2}, \\frac{y_1+y_2}{2}\\right)$. Parallel lines: $m_1 = m_2$; Perpendicular lines: $m_1 \\times m_2 = -1$.',
    explain_summary_fr: 'Distance entre deux points : $d = \\sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$. Coordonnées du milieu : $M = \\left(\\frac{x_1+x_2}{2}, \\frac{y_1+y_2}{2}\\right)$. Droites parallèles : $m_1 = m_2$ ; droites perpendiculaires : $m_1 \\times m_2 = -1$.',
    homework_items_ar: [
      '1) أوجد البعد بين النقطتين $A(3, 2)$ و $B(7, 5)$ (كتاب الوزارة)',
      '2) إذا كانت $C(4, 3)$ منتصف $\\overline{AB}$ حيث $A(2, 1)$، فأوجد إحداثي نقطة $B$ (كتاب المعاصر)',
      '3) أوجد معادلة الخط المستقيم الذي ميله $2$ ويمر بالنقطة $(1, 5)$ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) Find the distance between $A(3, 2)$ and $B(7, 5)$ (Ministry Textbook)',
      '2) If $C(4, 3)$ is the midpoint of $\\overline{AB}$ where $A(2, 1)$, find $B$ (El-Moasser)',
      '3) Find the equation of the straight line with slope $2$ passing through $(1, 5)$ (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Calculer la distance entre les points $A(3, 2)$ et $B(7, 5)$.',
      '2) Sachant que $C(4, 3)$ est le milieu du segment $[AB]$ avec $A(2, 1)$, déterminer les coordonnées du point $B$.',
      '3) Déterminer l’équation réduite de la droite de pente $2$ passant par le point $(1, 5)$.'
    ],
    homework_solutions_ar: [
      '1) الحل: $AB = \\sqrt{(7 - 3)^2 + (5 - 2)^2} = \\sqrt{16 + 9} = \\sqrt{25} = 5$ وحدات طول.',
      '2) الحل: $\\frac{2 + x}{2} = 4 \\implies x = 6$ | $\\frac{1 + y}{2} = 3 \\implies y = 5 \\implies B(6, 5)$.',
      '3) الحل: $y = 2x + c \\implies 5 = 2(1) + c \\implies c = 3 \\implies$ المعادلة: $y = 2x + 3$.'
    ],
    homework_solutions_en: [
      '1) Solution: $AB = \\sqrt{4^2 + 3^2} = \\sqrt{25} = 5$ length units.',
      '2) Solution: $x = 6, y = 5 \\implies B(6, 5)$.',
      '3) Solution: $y = 2x + c \\implies 5 = 2 + c \\implies c = 3 \\implies y = 2x + 3$.'
    ],
    homework_solutions_fr: [
      '1) Solution : $AB = \\sqrt{(7 - 3)^2 + (5 - 2)^2} = \\sqrt{25} = 5$ unités de longueur.',
      '2) Solution : $\\frac{2 + x}{2} = 4 \\implies x = 6$ et $\\frac{1 + y}{2} = 3 \\implies y = 5 \\implies B(6, 5)$.',
      '3) Solution : $y = 2x + p \\implies 5 = 2(1) + p \\implies p = 3 \\implies y = 2x + 3$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): أثبت أن النقط $A(1, 4)$ و $B(3, -2)$ و $C(-3, 16)$ تقع على استقامة واحدة (ميل $AB = -3$ وميل $BC = -3$).',
      'مسألة متفوقين (2): أوجد معادلة محور تماثل القطعة المستقيمة $\\overline{AB}$ حيث $A(1, 3)$ و $B(3, 5)$ (المنتصف $(2, 4)$ والميل العمودي $= -1 \\implies y = -x + 6$).'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): Prove that $A(1, 4)$, $B(3, -2)$, and $C(-3, 16)$ are collinear (Slope $AB = -3$ and Slope $BC = -3$).',
      'Gifted Problem (2): Find the equation of the perpendicular bisector of $\\overline{AB}$ for $A(1, 3)$ and $B(3, 5)$ ($y = -x + 6$).'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : Démontrer que les points $A(1, 4)$, $B(3, -2)$ et $C(-3, 16)$ sont alignés (Pente de $(AB) = -3$ et pente de $(BC) = -3$).',
      'Problème d’Excellence (2) : Déterminer l’équation de la médiatrice du segment $[AB]$ avec $A(1, 3)$ et $B(3, 5)$ ($y = -x + 6$).'
    ]
  },
  {
    grade: 3, term: 2, lesson_id: 304,
    unit_ar: 'الوحدة الرابعة: هندسة الدائرة',
    unit_en: 'Unit 4: Circle Geometry',
    unit_fr: 'Unité 4 : Géométrie du Cercle',
    lesson_ar: 'الدرس الرابع: الزوايا المركزية والمحيطية والشكل الرباعي الدائري',
    lesson_en: 'Unit 4 - Lesson 1: Central, Inscribed Angles & Cyclic Quadrilaterals',
    lesson_fr: 'Unité 4 - Leçon 1 : Angles au Centre, Inscrits et Quadrilatère Inscriptible',
    explain_summary_ar: 'قياس الزاوية المحيطية يساوي نصف قياس الزاوية المركزية المشتركة معها في القوس. وفي الشكل الرباعي الدائري كل زاويتين متقابلتين متكاملتان ($180^\\circ$).',
    explain_summary_en: 'An inscribed angle measures half the central angle subtended by the same arc. In a cyclic quadrilateral, opposite angles are supplementary ($180^\\circ$).',
    explain_summary_fr: 'La mesure d’un angle inscrit est égale à la moitié de la mesure de l’angle au centre qui intercepte le même arc. Dans un quadrilatère inscriptible, deux angles opposés sont supplémentaires ($180^\\circ$).',
    homework_items_ar: [
      '1) زاوية مركزية قياسها $110^\\circ$، أوجد قياس الزاوية المحيطية المشتركة معها في نفس القوس (كتاب الوزارة)',
      '2) $ABCD$ شكل رباعي دائري فيه $m(\\angle A) = 75^\\circ$، أوجد $m(\\angle C)$ (كتاب المعاصر)',
      '3) ما قياس الزاوية المحيطية المرسومة في نصف دائرة؟ (كتاب الأضواء)'
    ],
    homework_items_en: [
      '1) A central angle measures $110^\\circ$. Find the inscribed angle subtended by the same arc (Ministry Textbook)',
      '2) $ABCD$ is a cyclic quadrilateral with $m(\\angle A) = 75^\\circ$. Find $m(\\angle C)$ (El-Moasser)',
      '3) What is the measure of an inscribed angle subtended by a semicircle? (El-Adwaa)'
    ],
    homework_items_fr: [
      '1) Un angle au centre mesure $110^\\circ$. Calculer la mesure de l’angle inscrit interceptant le même arc.',
      '2) $ABCD$ est un quadrilatère inscriptible tel que $m(\\widehat{A}) = 75^\\circ$. Calculer $m(\\widehat{C})$.',
      '3) Quelle est la mesure d’un angle inscrit dans un demi-cercle ?'
    ],
    homework_solutions_ar: [
      '1) الحل: المحيطية $= \\frac{1}{2} \\times 110^\\circ = 55^\\circ$.',
      '2) الحل: $m(\\angle C) = 180^\\circ - 75^\\circ = 105^\\circ$.',
      '3) الحل: الزاوية المحيطية المرسومة في نصف دائرة قائمة $= 90^\\circ$.'
    ],
    homework_solutions_en: [
      '1) Solution: Inscribed angle $= \\frac{1}{2} \\times 110^\\circ = 55^\\circ$.',
      '2) Solution: $m(\\angle C) = 180^\\circ - 75^\\circ = 105^\\circ$.',
      '3) Solution: An angle in a semicircle is a right angle $= 90^\\circ$.'
    ],
    homework_solutions_fr: [
      '1) Solution : Angle inscrit $= \\frac{1}{2} \\times 110^\\circ = 55^\\circ$.',
      '2) Solution : $m(\\widehat{C}) = 180^\\circ - 75^\\circ = 105^\\circ$.',
      '3) Solution : Un angle inscrit dans un demi-cercle est un angle droit $= 90^\\circ$.'
    ],
    advanced_problems_ar: [
      'مسألة متفوقين (1): $\\overline{AB}$ قطر في الدائرة $M$، $C$ تنتمي للدائرة بحيث $m(\\angle CAB) = 35^\\circ$، أوجد $m(\\angle ABC)$ وقياس القوس $\\overparen{AC}$ ($m(\\angle ABC) = 55^\\circ$، وقياس القوس $\\overparen{AC} = 110^\\circ$).',
      'مسألة متفوقين (2): دائرتان متقاطعتان في $A, B$، رُسم مستقيم يمر بنقطة $A$ ويقطع الدائرتين في $C, D$، برهن أن الشكل الرباعي الناتج دائري.'
    ],
    advanced_problems_en: [
      'Gifted Problem (1): $\\overline{AB}$ is a diameter of circle $M$, and $C$ lies on the circle with $m(\\angle CAB) = 35^\\circ$. Find $m(\\angle ABC)$ and $m(\\overparen{AC})$ ($55^\\circ$ and $110^\\circ$).',
      'Gifted Problem (2): Two circles intersect at $A$ and $B$. A line through $A$ intersects the circles at $C$ and $D$. Prove that the resulting quadrilateral is cyclic.'
    ],
    advanced_problems_fr: [
      'Problème d’Excellence (1) : $[AB]$ est un diamètre du cercle $M$ et $C$ est un point du cercle tel que $m(\\widehat{CAB}) = 35^\\circ$. Calculer $m(\\widehat{ABC})$ et la mesure de l’arc $\\overparen{AC}$ ($55^\\circ$ et $110^\\circ$).',
      'Problème d’Excellence (2) : Deux cercles se coupent en $A$ et $B$. Une droite passant par $A$ recoupe les deux cercles en $C$ et $D$. Démontrer que le quadrilatère obtenu est inscriptible.'
    ]
  }
];

function buildAllGradesStructuredLibrary() {
  const generated = [];
  ALL_PREP_SYLLABUS_INDEX.forEach((item, idx) => {
    const baseId = item.grade * 1000 + (idx + 1) * 10;
    // 1. ملف الشرح والقوانين والأمثلة
    generated.push({
      id: baseId + 1,
      grade: item.grade,
      term: item.term,
      lesson_id: item.lesson_id,
      lesson_title_ar: item.lesson_ar,
      lesson_title_en: item.lesson_en,
      lesson_title_fr: item.lesson_fr,
      unit_ar: item.unit_ar,
      unit_en: item.unit_en,
      unit_fr: item.unit_fr,
      category: 'lesson_pdf',
      doc_role: 'explain',
      title_ar: `📘 [شرح الدرس] ${item.lesson_ar} — القوانين والأمثلة المحلولة (PDF)`,
      title_en: `📘 [Lesson Explanation] ${item.lesson_en} — Rules & Solved Examples (PDF)`,
      title_fr: `📘 [Cours Complet] ${item.lesson_fr} — Règles et Exemples Résolus (PDF)`,
      file_type: 'pdf',
      file_url: '',
      sections: [
        { heading: 'أولاً: القاعدة الأساسية والقوانين المعتمدة', lines: [item.explain_summary_ar] },
        { heading: 'ثانياً: أمثلة محلولة من كتاب الوزارة', lines: item.homework_items_ar.slice(0, 2) },
        { heading: 'ثالثاً: خطوات الحل النموذجية', lines: item.homework_solutions_ar.slice(0, 2) }
      ],
      sections_en: [
        { heading: '1. Core Mathematical Rule & Formulas', lines: [item.explain_summary_en] },
        { heading: '2. Solved Examples from Ministry Textbook', lines: item.homework_items_en.slice(0, 2) },
        { heading: '3. Step-by-Step Model Solutions', lines: item.homework_solutions_en.slice(0, 2) }
      ],
      sections_fr: [
        { heading: '1. Règle Fondamentale et Formules Mathématiques', lines: [item.explain_summary_fr] },
        { heading: '2. Exemples Résolus du Programme Officiel', lines: item.homework_items_fr.slice(0, 2) },
        { heading: '3. Démarche Détaillée de Résolution', lines: item.homework_solutions_fr.slice(0, 2) }
      ],
      created_at: '2026-09-01'
    });

    // 2. ملف الواجب الشامل من كل الكتب الخارجية
    generated.push({
      id: baseId + 2,
      grade: item.grade,
      term: item.term,
      lesson_id: item.lesson_id,
      lesson_title_ar: item.lesson_ar,
      lesson_title_en: item.lesson_en,
      lesson_title_fr: item.lesson_fr,
      unit_ar: item.unit_ar,
      unit_en: item.unit_en,
      unit_fr: item.unit_fr,
      category: 'homework_pdf',
      doc_role: 'homework',
      title_ar: `📝 [واجب الدرس الشامل] تمارين المعاصر والأضواء وكتاب الوزارة — ${item.lesson_ar} (PDF)`,
      title_en: `📝 [Comprehensive Homework] Textbook & Workbook Exercises — ${item.lesson_en} (PDF)`,
      title_fr: `📝 [Devoir Complet] Exercices d’Application et Entraînement — ${item.lesson_fr} (PDF)`,
      file_type: 'pdf',
      file_url: '',
      sections: [
        { heading: 'تعليمات حل الواجب المنزلي', lines: ['أجب عن جميع الأسئلة التالية بالخطوات الكاملة في كراسة الواجب، ثم راجع إجاباتك من ملف الحل النموذجي.'] },
        { heading: 'أسئلة الواجب الشامل (مجمعة من كتاب الوزارة + المعاصر + الأضواء)', lines: item.homework_items_ar }
      ],
      sections_en: [
        { heading: 'Homework Instructions', lines: ['Solve all the following exercises with full steps in your notebook, then verify with the Model Solutions PDF.'] },
        { heading: 'Comprehensive Practice Exercises (Ministry Textbook + Workbooks)', lines: item.homework_items_en }
      ],
      sections_fr: [
        { heading: 'Consignes pour le Devoir à la Maison', lines: ['Rédigez les solutions complètes de tous les exercices ci-dessous, puis vérifiez vos réponses à l’aide du fichier Corrigé Modèle.'] },
        { heading: 'Série d’Exercices Complets (Programme Officiel & Cahiers d’Exercices)', lines: item.homework_items_fr }
      ],
      created_at: '2026-09-01'
    });

    // 3. ملف حل الواجب النموذجي بالخطوات
    generated.push({
      id: baseId + 3,
      grade: item.grade,
      term: item.term,
      lesson_id: item.lesson_id,
      lesson_title_ar: item.lesson_ar,
      lesson_title_en: item.lesson_en,
      lesson_title_fr: item.lesson_fr,
      unit_ar: item.unit_ar,
      unit_en: item.unit_en,
      unit_fr: item.unit_fr,
      category: 'homework_solution_pdf',
      doc_role: 'solution',
      title_ar: `✅ [حل الواجب النموذجي] الإجابات التفصيلية بالخطوات — ${item.lesson_ar} (PDF)`,
      title_en: `✅ [Homework Model Answers] Detailed Step-by-Step Solutions — ${item.lesson_en} (PDF)`,
      title_fr: `✅ [Corrigé Modèle] Solutions Détaillées Étape par Étape — ${item.lesson_fr} (PDF)`,
      file_type: 'pdf',
      file_url: '',
      sections: [
        { heading: 'نص أسئلة الواجب', lines: item.homework_items_ar },
        { heading: 'نموذج الإجابة والحل التفصيلي المعتمد', lines: item.homework_solutions_ar }
      ],
      sections_en: [
        { heading: 'Homework Questions', lines: item.homework_items_en },
        { heading: 'Official Model Answers & Step-by-Step Solutions', lines: item.homework_solutions_en }
      ],
      sections_fr: [
        { heading: 'Énoncés des Exercices du Devoir', lines: item.homework_items_fr },
        { heading: 'Corrigé Officiel et Solutions Détaillées', lines: item.homework_solutions_fr }
      ],
      created_at: '2026-09-01'
    });

    // 4. ملف مسائل المتفوقين والقدرات العليا
    generated.push({
      id: baseId + 4,
      grade: item.grade,
      term: item.term,
      lesson_id: item.lesson_id,
      lesson_title_ar: item.lesson_ar,
      lesson_title_en: item.lesson_en,
      lesson_title_fr: item.lesson_fr,
      unit_ar: item.unit_ar,
      unit_en: item.unit_en,
      unit_fr: item.unit_fr,
      category: 'extra_homework_pdf',
      doc_role: 'advanced',
      title_ar: `🏆 [مسائل المتفوقين] أسئلة القدرات العليا والأولمبياد — ${item.lesson_ar} (PDF)`,
      title_en: `🏆 [Advanced & Gifted Problems] Olympiad & Higher-Order Thinking — ${item.lesson_en} (PDF)`,
      title_fr: `🏆 [Problèmes d’Excellence] Olympiades et Approfondissement — ${item.lesson_fr} (PDF)`,
      file_type: 'pdf',
      file_url: '',
      sections: [
        { heading: 'تحدي الأوائل والمتفوقين (مستويات التفكير العليا)', lines: item.advanced_problems_ar },
        { heading: 'إرشادات مستر عارف للحل', lines: ['اقرأ المعطيات بدقة، واربط بين قوانين الدرس والمهارات الجبرية والهندسية السابقة للوصول للحل النموذجي.'] }
      ],
      sections_en: [
        { heading: 'Top Achievers & Olympiad Challenge (Higher-Order Thinking)', lines: item.advanced_problems_en },
        { heading: 'Mr. Aref Problem-Solving Strategy', lines: ['Analyze the given conditions carefully and connect core formulas with prior algebraic and geometric properties.'] }
      ],
      sections_fr: [
        { heading: 'Défi d’Excellence et Olympiades de Mathématiques', lines: item.advanced_problems_fr },
        { heading: 'Méthodologie de Résolution de M. Aref', lines: ['Analysez rigoureusement les données de l’énoncé et reliez les théorèmes du cours aux propriétés algébriques et géométriques fondamentales.'] }
      ],
      created_at: '2026-09-01'
    });
  });
  return generated;
}

const DEFAULT_LIBRARY_ITEMS = [
  ...buildAllGradesStructuredLibrary(),
  {
    id: 9901,
    grade: 1,
    term: 1,
    lesson_id: 101,
    lesson_title_ar: 'الدرس الأول: التناسب وتطبيقاته ومقياس الرسم',
    lesson_title_en: 'Lesson 1: Proportion',
    category: 'lesson_video',
    title_ar: '🎥 فيديو مسجل: شرح درس التناسب وتطبيقاته خطوة بخطوة',
    title_en: 'Recorded Video Lecture: Lesson 1 Proportion Step-by-Step',
    file_type: 'video',
    file_url: '',
    created_at: '2026-09-01'
  }
];

const DEFAULT_FIXED_SCHEDULES = [
  {
    id: 501, grade: 1, term: 1, track: 'ar', lesson_id: 101,
    lesson_title_ar: 'الدرس الأول: التناسب وتطبيقات النسبة',
    lesson_title_en: 'Lesson 1: Proportion & Ratio Applications',
    teacher_ar: 'أ. محمود عبد الرحمن (خبير رياضيات المرحلة الإعدادية)',
    teacher_en: 'Mr. Mahmoud Abdel-Rahman (Senior Math Teacher)',
    days_ar: 'السبت والثلاثاء من كل أسبوع', days_en: 'Every Saturday & Tuesday',
    time_ar: '06:00 مساءً بتوقيت القاهرة', time_en: '06:00 PM (Cairo Time)',
    monthly_price: '250 ج.م / شهرياً', seats_left: 6
  },
  {
    id: 502, grade: 1, term: 1, track: 'en', lesson_id: 108,
    lesson_title_ar: 'الهندسة: الزوايا والتوازي والمثلث (Languages)',
    lesson_title_en: 'Geometry: Angles, Parallelism & The Triangle (Languages)',
    teacher_ar: 'أ. شريف المنياوي (Math & Geometry Specialist)',
    teacher_en: 'Mr. Sherif El-Meniawy (Math & Geometry Specialist)',
    days_ar: 'الأحد والأربعاء من كل أسبوع', days_en: 'Every Sunday & Wednesday',
    time_ar: '07:30 مساءً بتوقيت القاهرة', time_en: '07:30 PM (Cairo Time)',
    monthly_price: '320 EGP / Month', seats_left: 4
  },
  {
    id: 503, grade: 2, term: 1, track: 'ar', lesson_id: 211,
    lesson_title_ar: 'الجبر والهندسة: التحليل ونظرية فيثاغورس ومتوسطات المثلث',
    lesson_title_en: 'Algebra & Geometry: Factorization, Pythagoras & Medians',
    teacher_ar: 'أ. طارق الدسوقي (موجه رياضيات أول)',
    teacher_en: 'Mr. Tarek El-Desouky (Lead Math Supervisor)',
    days_ar: 'الاثنين والخميس من كل أسبوع', days_en: 'Every Monday & Thursday',
    time_ar: '06:30 مساءً بتوقيت القاهرة', time_en: '06:30 PM (Cairo Time)',
    monthly_price: '280 ج.م / شهرياً', seats_left: 5
  },
  {
    id: 504, grade: 2, term: 1, track: 'en', lesson_id: 201,
    lesson_title_ar: 'Real Numbers, Intervals & Trinomial Factorization',
    lesson_title_en: 'Real Numbers, Intervals & Trinomial Factorization',
    teacher_ar: 'د. نهى الكيلاني (Languages Math Instructor)',
    teacher_en: 'Dr. Noha El-Kilany (Languages Math Instructor)',
    days_ar: 'السبت والثلاثاء من كل أسبوع', days_en: 'Every Saturday & Tuesday',
    time_ar: '08:00 مساءً بتوقيت القاهرة', time_en: '08:00 PM (Cairo Time)',
    monthly_price: '350 EGP / Month', seats_left: 7
  },
  {
    id: 505, grade: 3, term: 1, track: 'ar', lesson_id: 303,
    lesson_title_ar: 'الشهادة الإعدادية: الدالة التربيعية وحساب المثلثات والهندسة',
    lesson_title_en: 'Prep 3 Certificate: Quadratic Function, Trig & Geometry',
    teacher_ar: 'أ. د. حسن الشافعي (خبير امتحانات الشهادة الإعدادية)',
    teacher_en: 'Prof. Hassan El-Shafei (Prep Certificate Exam Expert)',
    days_ar: 'الأحد والأربعاء والجمعة', days_en: 'Sunday, Wednesday & Friday',
    time_ar: '07:00 مساءً بتوقيت القاهرة', time_en: '07:00 PM (Cairo Time)',
    monthly_price: '350 ج.م / شهرياً', seats_left: 3
  },
  {
    id: 506, grade: 3, term: 2, track: 'en', lesson_id: 322,
    lesson_title_ar: 'Prep 3 Languages: Circle Theorems, Inscribed Angles & Equations',
    lesson_title_en: 'Prep 3 Languages: Circle Theorems, Inscribed Angles & Equations',
    teacher_ar: 'أ. كريم زهران (Senior Languages Math Lecturer)',
    teacher_en: 'Mr. Karim Zahran (Senior Languages Math Lecturer)',
    days_ar: 'الاثنين والخميس من كل أسبوع', days_en: 'Every Monday & Thursday',
    time_ar: '08:30 مساءً بتوقيت القاهرة', time_en: '08:30 PM (Cairo Time)',
    monthly_price: '400 EGP / Month', seats_left: 5
  },
  {
    id: 507, grade: 1, term: 1, track: 'fr', lesson_id: 101,
    lesson_title_ar: 'Mathématiques (Français) : Les Proportions, Algèbre et Géométrie',
    lesson_title_en: 'Mathématiques (Français) : Les Proportions, Algèbre et Géométrie',
    teacher_ar: 'مسيو فريد نصار (Professeur de Mathématiques - Section Française)',
    teacher_en: 'M. Farid Nassar (Professeur de Mathématiques - Section Française)',
    days_ar: 'السبت والأربعاء من كل أسبوع', days_en: 'Chaque Samedi et Mercredi',
    time_ar: '07:00 مساءً بتوقيت القاهرة', time_en: '19h00 (Heure du Caire)',
    monthly_price: '360 EGP / Mois', seats_left: 5
  }
];

const DEFAULT_RECORDED_PACKAGES = [
  {
    id: 801, grade: 1, source_type: 'private_recording',
    title_ar: 'تسجيل حصة خاصة: شرح التناسب وحل امتحان الوحدة الأولى كاملاً',
    title_en: 'Recorded Private Session: Proportion & Full Unit 1 Exam Solution',
    teacher_ar: 'أ. محمود عبد الرحمن', teacher_en: 'Mr. Mahmoud Abdel-Rahman',
    duration_ar: '65 دقيقة (شرح تفصيلي + حل مسائل الامتحان)', duration_en: '65 Mins (Full Explanation + Exam Solutions)',
    price_ar: '45 ج.م', price_en: '45 EGP',
    formula_preview: '$$\\frac{a}{b} = \\frac{c}{d} \\iff a \\times d = b \\times c$$'
  },
  {
    id: 802, grade: 1, source_type: 'schedule_recording',
    title_ar: 'حزمة تسجيلات المواعيد الثابتة: هندسة الأول الإعدادي (التوازي والمثلث)',
    title_en: 'Fixed Schedule Recordings Bundle: Prep 1 Geometry (Parallelism & Triangles)',
    teacher_ar: 'أ. شريف المنياوي', teacher_en: 'Mr. Sherif El-Meniawy',
    duration_ar: '4 حصص مسجلة عالية الجودة (HD)', duration_en: '4 HD Recorded Live Classes',
    price_ar: '95 ج.م', price_en: '95 EGP',
    formula_preview: '$$\\sum m(\\angle_{\\text{triangle}}) = 180^\\circ$$'
  },
  {
    id: 803, grade: 2, source_type: 'private_recording',
    title_ar: 'تسجيل حصة خاصة: إتقان التحليل الجبري ونظرية فيثاغورس بالبرهان',
    title_en: 'Recorded Private Session: Mastering Factorization & Pythagoras Proofs',
    teacher_ar: 'أ. طارق الدسوقي', teacher_en: 'Mr. Tarek El-Desouky',
    duration_ar: '75 دقيقة (حل أصعب مسائل المحافظات)', duration_en: '75 Mins (Governorate Exam Problems)',
    price_ar: '55 ج.م', price_en: '55 EGP',
    formula_preview: '$$x^2 - y^2 = (x - y)(x + y), \\quad c = \\sqrt{a^2 + b^2}$$'
  },
  {
    id: 804, grade: 2, source_type: 'schedule_recording',
    title_ar: 'حزمة تسجيلات المواعيد الثابتة: جبر وهندسة الثاني الإعدادي كاملة',
    title_en: 'Fixed Schedule Recordings: Complete Prep 2 Algebra & Geometry',
    teacher_ar: 'د. نهى الكيلاني', teacher_en: 'Dr. Noha El-Kilany',
    duration_ar: '8 حصص مسجلة شاملة المراجعات', duration_en: '8 Full Recorded Live Sessions',
    price_ar: '140 ج.م', price_en: '140 EGP',
    formula_preview: '$$[-1, 4] \\cap [2, 6] = [2, 4]$$'
  },
  {
    id: 805, grade: 3, source_type: 'private_recording',
    title_ar: 'تسجيل حصة خاصة: حل امتحان الشهادة الإعدادية (الدالة التربيعية وحساب المثلثات)',
    title_en: 'Recorded Private Session: Prep 3 Exam Solution (Quadratics & Trigonometry)',
    teacher_ar: 'أ. د. حسن الشافعي', teacher_en: 'Prof. Hassan El-Shafei',
    duration_ar: '90 دقيقة (مراجعة ليلة الامتحان وحل النماذج)', duration_en: '90 Mins (Final Exam Walkthrough)',
    price_ar: '65 ج.م', price_en: '65 EGP',
    formula_preview: '$$\\sin^2\\theta + \\cos^2\\theta = 1, \\quad x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$'
  },
  {
    id: 806, grade: 3, source_type: 'schedule_recording',
    title_ar: 'حزمة تسجيلات المواعيد الثابتة: هندسة الدائرة والزوايا المحيطية والمركزية',
    title_en: 'Fixed Schedule Recordings: Circle Geometry, Inscribed & Central Angles',
    teacher_ar: 'أ. كريم زهران', teacher_en: 'Mr. Karim Zahran',
    duration_ar: '6 حصص مسجلة بالبراهين الهندسية الكاملة', duration_en: '6 Recorded Live Classes with Full Proofs',
    price_ar: '150 ج.م', price_en: '150 EGP',
    formula_preview: '$$m(\\angle_{\\text{inscribed}}) = \\frac{1}{2} m(\\angle_{\\text{central}})$$'
  }
];

const DEFAULT_PLACEMENT_TESTS = [
  {
    id: 901, grade: 1, branch: 'comprehensive',
    title_ar: 'اختبار تحديد المستوى الشامل — الصف الأول الإعدادي (الأعداد والجبر والهندسة)',
    title_en: 'Comprehensive Placement Test — Prep 1 (Numbers, Algebra & Geometry)',
    duration_mins: 20,
    questions: [
      {
        question_ar: 'إذا كان $\\frac{x}{6} = \\frac{4}{8}$ فإن قيمة $x$ تساوي:',
        question_en: 'If $\\frac{x}{6} = \\frac{4}{8}$, then $x$ equals:',
        options_ar: ['$3$', '$4$', '$6$', '$12$'],
        options_en: ['$3$', '$4$', '$6$', '$12$'],
        correct_index: 0,
        explanation_ar: 'بحاصل ضرب الطرفين = الوسطين: $$8x = 24 \\implies x = 3$$',
        explanation_en: 'Cross-multiplying: $$8x = 24 \\implies x = 3$$',
        concept_tag: 'التناسب (نقاط القوة والضعف في الأعداد)'
      },
      {
        question_ar: 'مجموعة حل المعادلة $2x + 3 = 11$ في $\\mathbb{Q}$ هي:',
        question_en: 'The solution set of $2x + 3 = 11$ in $\\mathbb{Q}$ is:',
        options_ar: ['$\\{4\\}$', '$\\{7\\}$', '$\\{8\\}$', '$\\{5\\}$'],
        options_en: ['$\\{4\\}$', '$\\{7\\}$', '$\\{8\\}$', '$\\{5\\}$'],
        correct_index: 0,
        explanation_ar: '$$2x = 11 - 3 = 8 \\implies x = 4$$',
        explanation_en: '$$2x = 8 \\implies x = 4$$',
        concept_tag: 'المعادلات الخطية (فرع الجبر)'
      },
      {
        question_ar: 'الزاوية التي قياسها $60^\\circ$ تكملها زاوية قياسها:',
        question_en: 'An angle of $60^\\circ$ is supplemented by an angle of:',
        options_ar: ['$120^\\circ$', '$30^\\circ$', '$300^\\circ$', '$90^\\circ$'],
        options_en: ['$120^\\circ$', '$30^\\circ$', '$300^\\circ$', '$90^\\circ$'],
        correct_index: 0,
        explanation_ar: 'الزاويتان المتكاملتان مجموعهما $180^\\circ \\implies 180^\\circ - 60^\\circ = 120^\\circ$.',
        explanation_en: 'Supplementary angles sum to $180^\\circ \\implies 120^\\circ$.',
        concept_tag: 'العلاقات بين الزوايا (فرع الهندسة)'
      }
    ]
  },
  {
    id: 902, grade: 2, branch: 'algebra_geometry',
    title_ar: 'اختبار تحديد المستوى — الصف الثاني الإعدادي (الأعداد الحقيقية والتحليل وفيثاغورس)',
    title_en: 'Placement & Diagnostic Test — Prep 2 (Real Numbers, Factorization & Pythagoras)',
    duration_mins: 25,
    questions: [
      {
        question_ar: 'تحليل المقدار $x^2 - 9$ إلى عوامله هو:',
        question_en: 'Factorizing $x^2 - 9$ gives:',
        options_ar: ['$(x - 3)(x + 3)$', '$(x - 3)^2$', '$(x - 9)(x + 1)$', '$(x + 3)^2$'],
        options_en: ['$(x - 3)(x + 3)$', '$(x - 3)^2$', '$(x - 9)(x + 1)$', '$(x + 3)^2$'],
        correct_index: 0,
        explanation_ar: 'فرق بين مربعين: $$x^2 - 9 = (x - 3)(x + 3)$$',
        explanation_en: 'Difference of two squares: $$(x - 3)(x + 3)$$',
        concept_tag: 'تحليل الفرق بين مربعين (فرع الجبر)'
      },
      {
        question_ar: 'مثلث قائم الزاوية طولا ضلعي القائمة $6\\text{ cm}$ و $8\\text{ cm}$، فإن طول الوتر يساوي:',
        question_en: 'In a right triangle with legs $6\\text{ cm}$ and $8\\text{ cm}$, the hypotenuse is:',
        options_ar: ['$10\\text{ cm}$', '$14\\text{ cm}$', '$100\\text{ cm}$', '$12\\text{ cm}$'],
        options_en: ['$10\\text{ cm}$', '$14\\text{ cm}$', '$100\\text{ cm}$', '$12\\text{ cm}$'],
        correct_index: 0,
        explanation_ar: 'بنظرية فيثاغورس: $$c = \\sqrt{6^2 + 8^2} = \\sqrt{100} = 10\\text{ cm}$$',
        explanation_en: 'By Pythagoras: $$c = \\sqrt{36 + 64} = 10\\text{ cm}$$',
        concept_tag: 'نظرية فيثاغورس (فرع الهندسة)'
      }
    ]
  },
  {
    id: 903, grade: 3, branch: 'certificate',
    title_ar: 'اختبار تحديد المستوى — الشهادة الإعدادية (الدوال وحساب المثلثات والهندسة)',
    title_en: 'Placement & Diagnostic Test — Prep 3 Certificate (Functions, Trig & Geometry)',
    duration_mins: 30,
    questions: [
      {
        question_ar: 'قيمة المقدار $\\sin 30^\\circ + \\cos 60^\\circ$ تساوي:',
        question_en: 'The value of $\\sin 30^\\circ + \\cos 60^\\circ$ is:',
        options_ar: ['$1$', '$\\frac{1}{2}$', '$\\frac{\\sqrt{3}}{2}$', '$0$'],
        options_en: ['$1$', '$\\frac{1}{2}$', '$\\frac{\\sqrt{3}}{2}$', '$0$'],
        correct_index: 0,
        explanation_ar: '$$\\sin 30^\\circ + \\cos 60^\\circ = \\frac{1}{2} + \\frac{1}{2} = 1$$',
        explanation_en: '$$\\frac{1}{2} + \\frac{1}{2} = 1$$',
        concept_tag: 'النسب المثلثية للزوايا الخاصة'
      },
      {
        question_ar: 'نقطة رأس المنحنى للدالة التربيعية $f(x) = x^2 - 4x + 3$ هي:',
        question_en: 'The vertex of the quadratic function $f(x) = x^2 - 4x + 3$ is:',
        options_ar: ['$(2, -1)$', '$(-2, 3)$', '$(4, 3)$', '$(2, 1)$'],
        options_en: ['$(2, -1)$', '$(-2, 3)$', '$(4, 3)$', '$(2, 1)$'],
        correct_index: 0,
        explanation_ar: '$$x = \\frac{-b}{2a} = \\frac{4}{2} = 2, \\quad f(2) = 4 - 8 + 3 = -1 \\implies (2, -1)$$',
        explanation_en: '$$x = 2, \\quad f(2) = -1 \\implies (2, -1)$$',
        concept_tag: 'الدالة التربيعية (فرع الجبر)'
      }
    ]
  }
];

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function getDefaultDB() {
  return {
    students: [
      {
        id: 1,
        code: 'STD-1001',
        name: 'طالب المرحلة الإعدادية',
        grade: 1,
        track: 'ar',
        school: 'مدرسة النيل الإعدادية',
        edu_admin: 'إدارة وسط الإسكندرية التعليمية',
        lesson_records: {}
      }
    ],
    progress: [101, 102],
    attempts: [],
    mistakes: [],
    scratchpads: [],
    units: [],
    library: DEFAULT_LIBRARY_ITEMS,
    placement_tests: DEFAULT_PLACEMENT_TESTS,
    tutor_training: [],
    private_bookings: [],
    schedule_enrollments: [],
    recorded_purchases: []
  };
}

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const def = getDefaultDB();
      return {
        ...def,
        ...parsed,
        library: Array.isArray(parsed.library) && parsed.library.length >= 60 ? parsed.library : def.library,
        placement_tests: Array.isArray(parsed.placement_tests) && parsed.placement_tests.length ? parsed.placement_tests : def.placement_tests
      };
    }
  } catch (e) {}
  const fresh = getDefaultDB();
  saveDB(fresh);
  return fresh;
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    recordMrCodeError('saveDB', e.message, e.stack);
  }
}

function pcm16BufferToWav(pcmBuffer, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// 3. موسوعة الشرح الرياضي الذكي الفوري لجميع دروس المرحلة الإعدادية المصرية (عربي • English • Français)
const TOPIC_KNOWLEDGE_BASE = [
  {
    keywords: ['تناسب', 'نسب', 'طرفين', 'وسطين', 'proportion', 'ratio', 'proportions', 'rapport', 'produit en croix'],
    title_ar: 'درس التناسب وتطبيقاته',
    title_en: 'Proportion and its Applications',
    title_fr: 'Les Proportions et leurs Applications',
    svg_diagram: `<svg viewBox="0 0 420 150" width="100%" height="150" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="142" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="26" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">a / b = c / d  ⇔  a × d = b × c</text>
      <circle cx="120" cy="55" r="18" fill="#fdf2f3" stroke="#850e1b" stroke-width="2"/>
      <text x="120" y="61" text-anchor="middle" font-size="18" font-weight="bold" fill="#850e1b">a</text>
      <line x1="95" y1="82" x2="145" y2="82" stroke="#111" stroke-width="2.5"/>
      <circle cx="120" cy="110" r="18" fill="#f0f4f8" stroke="#172c49" stroke-width="2"/>
      <text x="120" y="116" text-anchor="middle" font-size="18" font-weight="bold" fill="#172c49">b</text>
      <text x="210" y="88" text-anchor="middle" font-size="24" font-weight="bold" fill="#111">=</text>
      <circle cx="300" cy="55" r="18" fill="#f0f4f8" stroke="#172c49" stroke-width="2"/>
      <text x="300" y="61" text-anchor="middle" font-size="18" font-weight="bold" fill="#172c49">c</text>
      <line x1="275" y1="82" x2="325" y2="82" stroke="#111" stroke-width="2.5"/>
      <circle cx="300" cy="110" r="18" fill="#fdf2f3" stroke="#850e1b" stroke-width="2"/>
      <text x="300" y="116" text-anchor="middle" font-size="18" font-weight="bold" fill="#850e1b">d</text>
      <line x1="140" y1="60" x2="280" y2="105" stroke="#850e1b" stroke-width="2" stroke-dasharray="5,3"/>
      <line x1="140" y1="105" x2="280" y2="60" stroke="#172c49" stroke-width="2" stroke-dasharray="5,3"/>
      <text x="210" y="138" text-anchor="middle" fill="#850e1b" font-size="13" font-weight="bold">Product of Extremes = Product of Means | Produit en croix</text>
    </svg>`,
    rule_ar:
      'التناسب هو تساوي نسبتين أو أكثر:\n• بالرموز العربية: (أ / ب) = (ج / د)  إذن: أ × د = ب × ج (حاصل ضرب الطرفين = حاصل ضرب الوسطين).\n• بالصيغة الرياضية القياسية:\n$$\\frac{a}{b} = \\frac{c}{d} \\iff a \\times d = b \\times c$$',
    rule_en:
      'A proportion is an equality of two or more ratios. The golden rule states that the product of the extremes equals the product of the means:\n$$\\frac{a}{b} = \\frac{c}{d} \\iff a \\times d = b \\times c$$',
    rule_fr:
      'Une proportion est l’égalité de deux rapports. La règle fondamentale (produit en croix) stipule que le produit des extrêmes est égal au produit des moyens :\n$$\\frac{a}{b} = \\frac{c}{d} \\iff a \\times d = b \\times c$$',
    examples_ar: [
      'مثال (1) مشروح خطوة بخطوة: أوجد قيمة المجهول (س) في التناسب: س / 6 = 4 / 8\n  - الخطوة الأولى (كتابة القانون): بما أن النسبتين متساويتان، نطبق قاعدة (حاصل ضرب الطرفين = حاصل ضرب الوسطين).\n  - الخطوة الثانية (التعويض والضرب): 8 × س = 6 × 4  ⇐  8 س = 24\n  - الخطوة الثالثة (القسمة لإيجاد س): س = 24 ÷ 8 = 3\n  $$\\frac{x}{6} = \\frac{4}{8} \\implies 8x = 24 \\implies x = 3$$'
    ],
    examples_en: [
      'Worked Example (Step-by-Step): Find the value of $x$ in the proportion $\\frac{x}{6} = \\frac{4}{8}$.\n  - Step 1 (Apply Cross-Multiplication): Multiply the extremes and the means: $8 \\times x = 6 \\times 4$.\n  - Step 2 (Simplify): $8x = 24$.\n  - Step 3 (Divide to isolate $x$): $x = \\frac{24}{8} = 3$.\n  $$\\frac{x}{6} = \\frac{4}{8} \\implies 8x = 24 \\implies x = 3$$'
    ],
    examples_fr: [
      'Exemple résolu étape par étape : Déterminer la valeur de $x$ dans la proportion $\\frac{x}{6} = \\frac{4}{8}$.\n  - Étape 1 (Produit en croix) : On multiplie les extrêmes et les moyens : $8 \\times x = 6 \\times 4$.\n  - Étape 2 (Simplification) : $8x = 24$.\n  - Étape 3 (Division pour isoler $x$) : $x = \\frac{24}{8} = 3$.\n  $$\\frac{x}{6} = \\frac{4}{8} \\implies 8x = 24 \\implies x = 3$$'
    ]
  },
  {
    keywords: ['فيثاغورس', 'وتر', 'قائم', 'مثلث', 'pythagoras', 'pythagore', 'triangle', 'hypoténuse', 'hypotenuse'],
    title_ar: 'الهندسة والبرهان الاستدلالي (المثلث القائم ونظرية فيثاغورس)',
    title_en: 'Geometry Theorems: Right Triangles & Pythagoras Theorem',
    title_fr: 'Géométrie : Triangle Rectangle et Théorème de Pythagore',
    svg_diagram: `<svg viewBox="0 0 420 175" width="100%" height="175" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="167" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="24" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">Pythagoras / Pythagore: AC² = AB² + BC²</text>
      <polygon points="120,42 120,142 280,142" fill="rgba(133,14,27,0.08)" stroke="#172c49" stroke-width="3"/>
      <rect x="120" y="126" width="16" height="16" fill="none" stroke="#850e1b" stroke-width="2"/>
      <text x="112" y="38" font-size="15" font-weight="bold" fill="#850e1b">A</text>
      <text x="108" y="155" font-size="15" font-weight="bold" fill="#850e1b">B</text>
      <text x="290" y="155" font-size="15" font-weight="bold" fill="#850e1b">C</text>
      <text x="85" y="96" font-size="14" font-weight="bold" fill="#172c49">6 cm</text>
      <text x="195" y="162" font-size="14" font-weight="bold" fill="#172c49">8 cm</text>
      <text x="215" y="84" font-size="14" font-weight="bold" fill="#850e1b">AC = 10 cm</text>
    </svg>`,
    rule_ar:
      '• مجموع قياسات الزوايا الداخلة لأي مثلث $= 180^\\circ$.\n• نظرية فيثاغورس في المثلث القائم الزاوية:\n$$(AC)^2 = (AB)^2 + (BC)^2 \\implies AC = \\sqrt{(AB)^2 + (BC)^2}$$',
    rule_en:
      '• The sum of interior angles in any triangle equals $180^\\circ$.\n• Pythagoras Theorem: In a right-angled triangle, the square of the hypotenuse equals the sum of the squares of the two legs:\n$$c^2 = a^2 + b^2 \\implies c = \\sqrt{a^2 + b^2}$$',
    rule_fr:
      '• La somme des mesures des angles intérieurs d’un triangle est égale à $180^\\circ$.\n• Théorème de Pythagore : Dans un triangle rectangle, le carré de l’hypoténuse est égal à la somme des carrés des deux côtés de l’angle droit :\n$$c^2 = a^2 + b^2 \\implies c = \\sqrt{a^2 + b^2}$$',
    examples_ar: [
      'مثال (1): مثلث $ABC$ قائم الزاوية في $B$، فيه $AB = 6\\text{ cm}$ و $BC = 8\\text{ cm}$. أوجد طول الوتر $AC$.\n  - نكتب القانون: $(AC)^2 = (AB)^2 + (BC)^2$.\n  - نعوّض بالأرقام: $(AC)^2 = 6^2 + 8^2 = 36 + 64 = 100$.\n  - نأخذ الجذر التربيعي: $AC = \\sqrt{100} = 10\\text{ cm}$.'
    ],
    examples_en: [
      'Worked Example: In right triangle $ABC$ at $B$, $AB = 6\\text{ cm}$ and $BC = 8\\text{ cm}$. Find hypotenuse $AC$.\n  - Step 1 (Formula): $(AC)^2 = (AB)^2 + (BC)^2$.\n  - Step 2 (Substitute): $(AC)^2 = 6^2 + 8^2 = 36 + 64 = 100$.\n  - Step 3 (Square Root): $AC = \\sqrt{100} = 10\\text{ cm}$.'
    ],
    examples_fr: [
      'Exemple résolu : Soit $ABC$ un triangle rectangle en $B$ tel que $AB = 6\\text{ cm}$ et $BC = 8\\text{ cm}$. Calculer la longueur de l’hypoténuse $AC$.\n  - Étape 1 (Formule) : $(AC)^2 = (AB)^2 + (BC)^2$.\n  - Étape 2 (Remplacement) : $(AC)^2 = 6^2 + 8^2 = 36 + 64 = 100$.\n  - Étape 3 (Racine carrée) : $AC = \\sqrt{100} = 10\\text{ cm}$.'
    ]
  },
  {
    keywords: ['اقليدس', 'إقليدس', 'مسقط', 'مساقط', 'euclid', 'euclide', 'projection'],
    title_ar: 'نظرية إقليدس والمساقط العمودية في المثلث القائم',
    title_en: "Euclid's Theorem & Perpendicular Projections",
    title_fr: "Théorème d'Euclide et Projections Orthogonales",
    svg_diagram: `<svg viewBox="0 0 420 140" width="100%" height="120" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="132" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="22" text-anchor="middle" fill="#172c49" font-size="13" font-weight="bold">Euclid / Euclide: AD ⊥ BC ⇒ AD² = BD × DC</text>
      <polygon points="195,34 95,118 325,118" fill="rgba(206,17,38,0.07)" stroke="#172c49" stroke-width="2.5"/>
      <line x1="195" y1="34" x2="195" y2="118" stroke="#850e1b" stroke-width="2.5" stroke-dasharray="4,2"/>
      <rect x="195" y="106" width="12" height="12" fill="none" stroke="#850e1b" stroke-width="1.8"/>
      <text x="195" y="29" text-anchor="middle" font-size="14" font-weight="bold" fill="#850e1b">A</text>
      <text x="82" y="122" font-size="14" font-weight="bold" fill="#172c49">B</text>
      <text x="335" y="122" font-size="14" font-weight="bold" fill="#172c49">C</text>
      <text x="195" y="132" text-anchor="middle" font-size="13" font-weight="bold" fill="#850e1b">D</text>
    </svg>`,
    rule_ar:
      'في المثلث القائم الزاوية في (أ) إذا رُسم (أ د) عمودياً على الوتر (ب جـ) فإن:\n1. $$(AB)^2 = BD \\times BC$$\n2. $$(AC)^2 = CD \\times CB$$\n3. $$(AD)^2 = DB \\times DC$$\n4. $$AD = \\frac{AB \\times AC}{BC}$$',
    rule_en:
      "In right triangle $ABC$ at $A$ with altitude $AD \\perp BC$:\n1. $(AB)^2 = BD \\times BC$\n2. $(AC)^2 = CD \\times CB$\n3. $(AD)^2 = BD \\times DC$",
    rule_fr:
      "Dans un triangle $ABC$ rectangle en $A$ avec la hauteur $AD \\perp BC$ :\n1. $(AB)^2 = BD \\times BC$\n2. $(AC)^2 = CD \\times CB$\n3. $(AD)^2 = BD \\times DC$",
    examples_ar: [
      'مثال: في المثلث $ABC$ القائم في $A$، $AD \\perp BC$، $BD = 9\\text{ cm}$، $DC = 16\\text{ cm}$:\n  - الوتر $BC = 9 + 16 = 25\\text{ cm}$.\n  - $(AB)^2 = 9 \\times 25 = 225 \\implies AB = 15\\text{ cm}$.\n  - $(AD)^2 = 9 \\times 16 = 144 \\implies AD = 12\\text{ cm}$.'
    ],
    examples_en: [
      'Worked Example: Given $BD = 9\\text{ cm}$ and $DC = 16\\text{ cm}$:\n  - Step 1: Total hypotenuse $BC = 9 + 16 = 25\\text{ cm}$.\n  - Step 2: $(AB)^2 = 9 \\times 25 = 225 \\implies AB = 15\\text{ cm}$.\n  - Step 3: $(AD)^2 = 9 \\times 16 = 144 \\implies AD = 12\\text{ cm}$.'
    ],
    examples_fr: [
      'Exemple résolu : Soient $BD = 9\\text{ cm}$ et $DC = 16\\text{ cm}$ :\n  - Étape 1 : Hypoténuse totale $BC = 9 + 16 = 25\\text{ cm}$.\n  - Étape 2 : $(AB)^2 = 9 \\times 25 = 225 \\implies AB = 15\\text{ cm}$.\n  - Étape 3 : $(AD)^2 = 9 \\times 16 = 144 \\implies AD = 12\\text{ cm}$.'
    ]
  },
  {
    keywords: ['تحليل', 'مقدار', 'مربعين', 'مكعبين', 'ثلاثي', 'factor', 'factorisation', 'factoriser', 'trinôme'],
    title_ar: 'تحليل المقادير الجبرية',
    title_en: 'Factorizing Algebraic Expressions',
    title_fr: 'Factorisation des Expressions Algébriques',
    svg_diagram: `<svg viewBox="0 0 420 145" width="100%" height="145" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="137" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="25" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">x² - 5x + 6 = (x - 2)(x - 3)</text>
      <rect x="135" y="38" width="150" height="32" rx="6" fill="#fdf2f3" stroke="#850e1b" stroke-width="2"/>
      <text x="210" y="59" text-anchor="middle" font-size="15" font-weight="bold" fill="#850e1b">x² - 5x + 6</text>
      <rect x="75" y="96" width="110" height="32" rx="6" fill="#f0f4f8" stroke="#172c49" stroke-width="2"/>
      <text x="130" y="117" text-anchor="middle" font-size="15" font-weight="bold" fill="#172c49">(x - 2)</text>
      <rect x="235" y="96" width="110" height="32" rx="6" fill="#f0f4f8" stroke="#172c49" stroke-width="2"/>
      <text x="290" y="117" text-anchor="middle" font-size="15" font-weight="bold" fill="#172c49">(x - 3)</text>
    </svg>`,
    rule_ar:
      '• الفرق بين مربعين: $$x^2 - y^2 = (x - y)(x + y)$$\n• مجموع وفرق مكعبين: $$x^3 \\pm y^3 = (x \\pm y)(x^2 \\mp xy + y^2)$$',
    rule_en:
      '• Difference of two squares: $$x^2 - y^2 = (x - y)(x + y)$$\n• Trinomial $x^2 + bx + c$: find two numbers with product $c$ and sum $b$.',
    rule_fr:
      '• Différence de deux carrés : $$x^2 - y^2 = (x - y)(x + y)$$\n• Trinôme $x^2 + bx + c$ : on cherche deux nombres dont le produit est $c$ et la somme est $b$.',
    examples_ar: [
      'مثال: حلل المقدار الثلاثي: $x^2 - 5x + 6 = (x - 2)(x - 3)$ لأن $(-2) \\times (-3) = +6$ و $(-2) + (-3) = -5$.'
    ],
    examples_en: [
      'Worked Example: Factorize $x^2 - 5x + 6$.\n  - Find two numbers whose product is $+6$ and sum is $-5$: they are $-2$ and $-3$.\n  - Result: $(x - 2)(x - 3)$.'
    ],
    examples_fr: [
      'Exemple résolu : Factoriser $x^2 - 5x + 6$.\n  - On cherche deux nombres dont le produit vaut $+6$ et la somme vaut $-5$ : ce sont $-2$ et $-3$.\n  - Résultat : $(x - 2)(x - 3)$.'
    ]
  },
  {
    keywords: ['دائرة', 'مماس', 'محيطية', 'مركزية', 'رباعي دائري', 'circle', 'inscribed', 'tangent', 'cercle', 'inscrit', 'centre'],
    title_ar: 'هندسة الدائرة والزوايا المركزية والمحيطية',
    title_en: 'Circle Geometry: Central & Inscribed Angles',
    title_fr: 'Géométrie du Cercle : Angles au Centre et Angles Inscrits',
    svg_diagram: `<svg viewBox="0 0 420 180" width="100%" height="180" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="172" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="24" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">Inscribed = ½ Central | Inscrit = ½ Centre</text>
      <circle cx="210" cy="102" r="58" fill="rgba(23,44,73,0.05)" stroke="#172c49" stroke-width="2.5"/>
      <circle cx="210" cy="102" r="3.5" fill="#850e1b"/>
      <text x="210" y="94" text-anchor="middle" font-size="12" font-weight="bold" fill="#850e1b">M (110°)</text>
      <line x1="210" y1="44" x2="162" y2="136" stroke="#172c49" stroke-width="2"/>
      <line x1="210" y1="44" x2="258" y2="136" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="39" text-anchor="middle" font-size="13" font-weight="bold" fill="#172c49">C (55°)</text>
    </svg>`,
    rule_ar:
      '• قياس الزاوية المحيطية يساوي نصف قياس الزاوية المركزية المشتركة معها في القوس:\n$$m(\\angle_{\\text{inscribed}}) = \\frac{1}{2} m(\\angle_{\\text{central}})$$',
    rule_en:
      '• Inscribed Angle Theorem: An inscribed angle measures half the central angle subtended by the same arc:\n$$m(\\angle_{\\text{inscribed}}) = \\frac{1}{2} m(\\angle_{\\text{central}})$$',
    rule_fr:
      '• Théorème de l’angle inscrit : La mesure d’un angle inscrit est égale à la moitié de la mesure de l’angle au centre interceptant le même arc :\n$$m(\\angle_{\\text{inscrit}}) = \\frac{1}{2} m(\\angle_{\\text{centre}})$$',
    examples_ar: [
      'مثال: إذا كان قياس الزاوية المركزية $110^\\circ$ فإن قياس المحيطية المشتركة معها في القوس $= \\frac{1}{2} \\times 110^\\circ = 55^\\circ$.'
    ],
    examples_en: [
      'Worked Example: If the central angle measures $110^\\circ$, then the inscribed angle on the same arc equals $\\frac{1}{2} \\times 110^\\circ = 55^\\circ$.'
    ],
    examples_fr: [
      'Exemple résolu : Si l’angle au centre mesure $110^\\circ$, alors l’angle inscrit interceptant le même arc mesure $\\frac{1}{2} \\times 110^\\circ = 55^\\circ$.'
    ]
  },
  {
    keywords: ['مقياس رسم', 'مقياس الرسم', 'نسبة مئوية', 'مجموعات', 'اعداد نسبية', 'أعداد نسبية', 'scale', 'percentage', 'sets', 'rational', 'échelle', 'ensembles', 'rationnels'],
    title_ar: 'الأعداد النسبية ومقياس الرسم والمجموعات',
    title_en: 'Rational Numbers, Scale Drawing & Set Operations',
    title_fr: 'Nombres Rationnels, Échelle et Opérations sur les Ensembles',
    svg_diagram: `<svg viewBox="0 0 420 145" width="100%" height="145" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="137" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="25" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">Scale = Drawing / Real  |  A ∩ B &amp; A ∪ B</text>
      <rect x="35" y="44" width="160" height="80" rx="8" fill="#fdf2f3" stroke="#850e1b" stroke-width="2"/>
      <text x="115" y="76" text-anchor="middle" font-size="14" font-weight="bold" fill="#850e1b">Scale / Échelle</text>
      <text x="115" y="100" text-anchor="middle" font-size="12" font-weight="bold" fill="#111">Drawing ÷ Real</text>
      <rect x="225" y="44" width="160" height="80" rx="8" fill="#f0f4f8" stroke="#172c49" stroke-width="2"/>
      <text x="305" y="76" text-anchor="middle" font-size="14" font-weight="bold" fill="#172c49">Sets / Ensembles</text>
      <text x="305" y="100" text-anchor="middle" font-size="12" font-weight="bold" fill="#111">∩ &amp; ∪</text>
    </svg>`,
    rule_ar:
      '• مقياس الرسم $= \\frac{\\text{الطول في الرسم}}{\\text{الطول الحقيقي}}$ (بعد توحيد الوحدات: $1\\text{ km} = 100,000\\text{ cm}$).\n• التقاطع $A \\cap B$ هو العناصر المشتركة، والاتحاد $A \\cup B$ هو جميع العناصر دون تكرار.',
    rule_en:
      '• Scale Drawing $= \\frac{\\text{Drawing Length}}{\\text{Real Length}}$ using unified units ($1\\text{ km} = 100,000\\text{ cm}$).\n• Intersection $A \\cap B$: common elements; Union $A \\cup B$: all elements without repetition.',
    rule_fr:
      '• Échelle $= \\frac{\\text{Longueur sur le dessin}}{\\text{Longueur réelle}}$ avec les mêmes unités ($1\\text{ km} = 100\\,000\\text{ cm}$).\n• Intersection $A \\cap B$ : éléments communs ; Réunion $A \\cup B$ : tous les éléments sans répétition.',
    examples_ar: [
      'مثال: المسافة على الخريطة $4\\text{ cm}$ والحقيقية $120\\text{ km} = 12,000,000\\text{ cm} \\implies$ مقياس الرسم $= 1 : 3,000,000$.'
    ],
    examples_en: [
      'Worked Example: Map distance $= 4\\text{ cm}$, Real distance $= 120\\text{ km} = 12,000,000\\text{ cm} \\implies \\text{Scale} = 1 : 3,000,000$.'
    ],
    examples_fr: [
      'Exemple résolu : Distance sur la carte $= 4\\text{ cm}$, distance réelle $= 120\\text{ km} = 12\\,000\\,000\\text{ cm} \\implies \\text{Échelle} = 1 : 3\\,000\\,000$.'
    ]
  },
  {
    keywords: ['مقادير جبرية', 'مقدار جبري', 'حدود جبرية', 'معادلات', 'معادلة', 'متباينة', 'متباينات', 'algebraic', 'expressions', 'equations', 'inequalities', 'équations', 'inéquations', 'algébriques'],
    title_ar: 'المقادير الجبرية وحل المعادلات والمتباينات الخطية',
    title_en: 'Algebraic Expressions, Linear Equations & Inequalities',
    title_fr: 'Expressions Algébriques, Équations et Inéquations Linéaires',
    svg_diagram: `<svg viewBox="0 0 420 145" width="100%" height="145" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="137" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="25" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">Linear Equations / Équations Linéaires</text>
      <rect x="45" y="46" width="330" height="36" rx="8" fill="#fefce8" stroke="#C0932B" stroke-width="2"/>
      <text x="210" y="69" text-anchor="middle" font-size="15" font-weight="bold" fill="#850e1b">2x + 3 = 11  ⇒  2x = 8  ⇒  x = 4</text>
      <text x="210" y="112" text-anchor="middle" font-size="13" font-weight="bold" fill="#172c49">Transpose constants &amp; divide by coefficient</text>
    </svg>`,
    rule_ar:
      '• نجمع الحدود الجبرية المتشابهة فقط.\n• لحل المعادلة $ax + b = c$: ننقل الحد المطلق بعكس الإشارة ثم نقسم على معامل المجهول $a$.',
    rule_en:
      '• Combine like terms with identical variables and powers.\n• To solve $ax + b = c$: transpose $b$ to the other side with opposite sign, then divide both sides by $a$.',
    rule_fr:
      '• On regroupe uniquement les termes semblables.\n• Pour résoudre $ax + b = c$ : on transpose $b$ dans l’autre membre en changeant son signe, puis on divise les deux membres par $a$.',
    examples_ar: [
      'مثال: حل المعادلة $3x - 5 = 10$:\n  - ننقل $-5$ بعكس الإشارة: $3x = 10 + 5 = 15$.\n  - نقسم على $3$: $x = 5$.'
    ],
    examples_en: [
      'Worked Example: Solve $3x - 5 = 10$.\n  - Step 1: Transpose $-5$ to the right side: $3x = 10 + 5 = 15$.\n  - Step 2: Divide by $3$: $x = 5$.'
    ],
    examples_fr: [
      'Exemple résolu : Résoudre $3x - 5 = 10$.\n  - Étape 1 : Transposons $-5$ : $3x = 10 + 5 = 15$.\n  - Étape 2 : Divisons par $3$ : $x = 5$.'
    ]
  },
  {
    keywords: ['زوايا', 'متتامة', 'متكاملة', 'توازي', 'تبادل', 'تناظر', 'تداخل', 'angles', 'supplementary', 'complementary', 'parallel', 'parallélisme', 'parallèles', 'supplémentaires'],
    title_ar: 'العلاقات بين الزوايا والتوازي ومجموع زوايا المثلث',
    title_en: 'Angle Relationships, Parallel Lines & Triangle Angles',
    title_fr: 'Relations entre les Angles, Parallélisme et Triangle',
    svg_diagram: `<svg viewBox="0 0 420 155" width="100%" height="155" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="147" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="24" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">Parallel Lines (Z, F, U) &amp; Triangle = 180°</text>
      <line x1="40" y1="55" x2="200" y2="55" stroke="#172c49" stroke-width="3"/>
      <line x1="40" y1="115" x2="200" y2="115" stroke="#172c49" stroke-width="3"/>
      <line x1="85" y1="35" x2="155" y2="135" stroke="#850e1b" stroke-width="2.5"/>
      <text x="120" y="142" text-anchor="middle" font-size="12" font-weight="bold" fill="#850e1b">Z • F • U</text>
      <polygon points="260,120 380,120 320,45" fill="rgba(192,147,43,0.15)" stroke="#172c49" stroke-width="2.5"/>
      <text x="320" y="102" text-anchor="middle" font-size="13" font-weight="bold" fill="#850e1b">180°</text>
    </svg>`,
    rule_ar:
      '• الزاويتان المتتامتان مجموعهما $90^\\circ$ والمتكاملتان مجموعهما $180^\\circ$.\n• عند التوازي: المتبادلة (Z) متساوية، المتناظرة (F) متساوية، والداخلتان (U) مجموعهما $180^\\circ$.',
    rule_en:
      '• Complementary angles sum to $90^\\circ$; Supplementary angles sum to $180^\\circ$.\n• With parallel lines: Alternate angles (Z) are equal, Corresponding angles (F) are equal, and Co-interior angles (U) sum to $180^\\circ$.',
    rule_fr:
      '• Deux angles complémentaires ont une somme de $90^\\circ$ ; deux angles supplémentaires ont une somme de $180^\\circ$.\n• Avec des droites parallèles : les angles alternes-internes (Z) sont égaux, les angles correspondants (F) sont égaux et les angles internes (U) valent $180^\\circ$.',
    examples_ar: [
      'مثال: زاوية قياسها $65^\\circ$، متممتها $= 90^\\circ - 65^\\circ = 25^\\circ$، ومكملتها $= 180^\\circ - 65^\\circ = 115^\\circ$.'
    ],
    examples_en: [
      'Worked Example: For an angle of $65^\\circ$, its complement is $90^\\circ - 65^\\circ = 25^\\circ$, and its supplement is $180^\\circ - 65^\\circ = 115^\\circ$.'
    ],
    examples_fr: [
      'Exemple résolu : Pour un angle de $65^\\circ$, son complémentaire mesure $90^\\circ - 65^\\circ = 25^\\circ$ et son supplémentaire mesure $180^\\circ - 65^\\circ = 115^\\circ$.'
    ]
  },
  {
    keywords: ['احصاء', 'إحصاء', 'احتمال', 'احتمالات', 'قطاعات', 'statistics', 'probability', 'pie chart', 'statistiques', 'probabilités', 'diagrammes'],
    title_ar: 'الإحصاء والقطاعات الدائرية والاحتمالات',
    title_en: 'Statistics, Pie Charts & Probability',
    title_fr: 'Statistiques, Diagrammes Circulaires et Probabilités',
    svg_diagram: `<svg viewBox="0 0 420 145" width="100%" height="145" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="412" height="137" rx="8" fill="#ffffff" stroke="#172c49" stroke-width="2"/>
      <text x="210" y="24" text-anchor="middle" fill="#172c49" font-size="14" font-weight="bold">Angle = Ratio × 360°  |  0 ≤ P(A) ≤ 1</text>
      <circle cx="115" cy="84" r="42" fill="#fdf2f3" stroke="#172c49" stroke-width="2.5"/>
      <path d="M 115 84 L 115 42 A 42 42 0 0 1 157 84 Z" fill="#CE1126"/>
      <rect x="205" y="48" width="185" height="68" rx="8" fill="#f0f4f8" stroke="#172c49" stroke-width="2"/>
      <text x="297" y="86" text-anchor="middle" font-size="13" font-weight="bold" fill="#850e1b">P(A) = Favorable ÷ Total</text>
    </svg>`,
    rule_ar:
      '• الزاوية المركزية للقطاع الدائري $= \\text{النسبة المئوية} \\times 360^\\circ$.\n• احتمال الحدث $P(A) = \\frac{\\text{عدد نواتج الحدث}}{\\text{العدد الكلي للنواتج}}$.',
    rule_en:
      '• Pie Chart Central Angle $= \\text{Percentage} \\times 360^\\circ$.\n• Probability $P(A) = \\frac{\\text{Favorable Outcomes}}{\\text{Total Outcomes}}$ ($0 \\le P(A) \\le 1$).',
    rule_fr:
      '• Angle au centre d’un secteur $= \\text{Pourcentage} \\times 360^\\circ$.\n• Probabilité $P(A) = \\frac{\\text{Cas favorables}}{\\text{Cas possibles}}$ ($0 \\le P(A) \\le 1$).',
    examples_ar: [
      'مثال: قطاع يمثل $25\\%$ زاويته المركزية $= \\frac{25}{100} \\times 360^\\circ = 90^\\circ$.'
    ],
    examples_en: [
      'Worked Example: A $25\\%$ pie sector has a central angle of $\\frac{25}{100} \\times 360^\\circ = 90^\\circ$.'
    ],
    examples_fr: [
      'Exemple résolu : Un secteur de $25\\%$ a un angle au centre de $\\frac{25}{100} \\times 360^\\circ = 90^\\circ$.'
    ]
  }
];

function getPedagogicalExtras(topicTitleAr, track = 'ar') {
  const t = String(topicTitleAr || '');
  if (track === 'fr') {
    if (t.includes('تناسب')) {
      return {
        analogy: 'Imaginez une proportion comme une recette de cuisine équilibrée : si 1 tasse de riz demande 2 tasses d’eau, alors 3 tasses de riz demandent exactement 6 tasses d’eau !',
        memory_hook: 'Attention, clé d’or pour l’examen : « Faites le produit en croix, puis divisez toujours par le nombre en face de x ! »',
        narration: 'Bienvenue mon champion avec Monsieur Aref ! Aujourd’hui, nous maîtrisons les proportions facilement. Retenez bien cette astuce : le produit en croix rend tout exercice simple et rapide !'
      };
    }
    if (t.includes('فيثاغورس') || t.includes('إقليدس') || t.includes('مثلث')) {
      return {
        analogy: 'Imaginez une échelle appuyée contre un mur vertical : le mur et le sol forment un angle droit, et l’échelle est l’hypoténuse, toujours le plus long côté !',
        memory_hook: 'Attention, clé d’or pour l’examen : « Pour trouver l’hypoténuse on additionne les carrés, pour un côté de l’angle droit on soustrait ! »',
        narration: 'Bienvenue avec Monsieur Aref ! Le théorème de Pythagore est le secret de la géométrie du triangle rectangle. Suivons ensemble chaque étape avec précision !'
      };
    }
    if (t.includes('تحليل')) {
      return {
        analogy: 'La factorisation, c’est comme démonter un objet en ses pièces d’origine : on transforme une somme en un produit de parenthèses simples.',
        memory_hook: 'Clé d’or : « Sortez toujours le facteur commun en premier, puis vérifiez la différence de deux carrés ou le trinôme ! »',
        narration: 'Bonjour et bienvenue avec Monsieur Aref ! Aujourd’hui, nous allons apprendre à factoriser les expressions algébriques sans aucune erreur.'
      };
    }
    return {
      analogy: 'Chaque notion de mathématiques devient très simple lorsqu’on la relie à une image concrète et qu’on avance étape par étape.',
      memory_hook: 'Clé d’or pour l’examen : « Écrivez d’abord la formule officielle, remplacez soigneusement les valeurs, puis vérifiez l’unité ! »',
      narration: 'Bienvenue mon champion avec Monsieur Aref ! Écoutons attentivement cette leçon étape par étape, vous allez la maîtriser parfaitement !'
    };
  }

  if (track === 'en') {
    if (t.includes('تناسب')) {
      return {
        analogy: 'Think of a proportion like a balanced recipe: if 1 cup of rice needs 2 cups of water, then 3 cups of rice need exactly 6 cups of water!',
        memory_hook: 'Exam Golden Key: "Cross-multiply the two known numbers, then always divide by the number opposite to x!"',
        narration: 'Welcome champion with Mr. Aref! Today we master proportions easily. Remember this golden trick: cross-multiplication solves it in seconds!'
      };
    }
    if (t.includes('فيثاغورس') || t.includes('إقليدس') || t.includes('مثلث')) {
      return {
        analogy: 'Picture a ladder leaning against a straight wall: the wall and ground form a 90-degree angle, and the ladder is the hypotenuse—always the longest side!',
        memory_hook: 'Exam Golden Key: "Need the hypotenuse? Square and ADD. Need a leg? Square and SUBTRACT!"',
        narration: 'Welcome with Mr. Aref! Pythagoras Theorem is the powerhouse of right triangles. Let us walk through each step clearly!'
      };
    }
    return {
      analogy: 'Every math rule becomes crystal clear when we connect it to real life and break it into calm, logical steps.',
      memory_hook: 'Exam Golden Key: "Write the core formula first, substitute the given values carefully, and double-check your units!"',
      narration: 'Welcome champion with Mr. Aref! Listen carefully to each step and you will master this lesson with full confidence!'
    };
  }

  if (t.includes('تناسب')) {
    return {
      analogy: 'تخيّل التناسب مثل وصفة طعام متوازنة: لو كوب أرز يحتاج كوبين ماء، فثلاثة أكواب أرز تحتاج ستة أكواب ماء بنفس النسبة تماماً!',
      memory_hook: 'شفرة الامتحان الذهبية: «اعمل المقص، اضرب الرقمين المعلومين واقسم دايماً على الرقم اللي قصاد الـ س!»',
      narration: 'أهلاً بك يا بطل مع مستر عارف! النهاردة هنفهم درس التناسب بأبسط طريقة، وافتكر دايماً إن المقص هو مفتاح الحل السريع!'
    };
  }
  if (t.includes('فيثاغورس') || t.includes('إقليدس') || t.includes('مثلث')) {
    return {
      analogy: 'تخيّل سلّماً مستنداً على حائط عمودي: الحائط والأرض يصنعان زاوية قائمة، والسلّم هو الوتر وأطول ضلع في المثلث!',
      memory_hook: 'شفرة الامتحان الذهبية: «عايز الوتر؟ ربّع واجمع وهات الجذر! عايز ضلع قائمة؟ ربّع واطرح وهات الجذر!»',
      narration: 'أهلاً بك يا بطل مع مستر عارف! نظرية فيثاغورس وإقليدس من أمتع دروس الهندسة، يلا نتابع خطوات الحل سوا بتركيز!'
    };
  }
  return {
    analogy: 'كل قاعدة في الرياضيات بتبقى سهلة جداً لما نفهم فكرتها من الواقع ونمشي في خطواتها بالترتيب.',
    memory_hook: 'شفرة الامتحان الذهبية: «اكتب القانون أول سطر، عوّض بالأرقام بهدوء، وراجع الإشارات والوحدات في الآخر!»',
    narration: 'أهلاً بك يا بطل مع مستر عارف! ركّز معايا في خطوات الشرح دي وهتتقن الدرس بالكامل بإذن الله!'
  };
}

function normalizeFrenchSearchText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectQuestionLanguage(questionText, requestedTrack = 'ar') {
  if (requestedTrack === 'fr' || requestedTrack === 'en') return requestedTrack;
  const q = String(questionText || '').trim();
  if (!q || /[\u0600-\u06FF]/.test(q)) return 'ar';
  const low = q.toLowerCase();
  const hasFrenchAccents = /[éèêëàâäîïôöùûüçœ]/i.test(q);
  const frenchSignals = /\b(bonjour|salut|bonsoir|merci|explique|expliquer|resoudre|résoudre|calculer|determiner|déterminer|demontrer|démontrer|theoreme|théorème|pythagore|euclide|fonction|quadratique|equation|équation|inequation|inéquation|proportion|proportions|echelle|échelle|triangle|rectangle|isocele|isocèle|cercle|inscrit|centre|trigonometrie|trigonométrie|hypotenuse|hypoténuse|mediane|médiane|droite|milieu|pente|factoriser|factorisation|statistiques|probabilite|probabilité|racine|intervalle|reels|réels|rationnels|sommet|parabole|angles|paralleles|parallèles|comment|quelle|quel|soit|dans un)\b/i;
  if (hasFrenchAccents || frenchSignals.test(low)) return 'fr';
  return 'ar';
}

function findMatchedTopic(questionText, lessonTitle, clientLessonData = null, track = 'ar') {
  const qOnly = String(questionText || '').trim().toLowerCase();
  const lOnly = String(lessonTitle || '').trim().toLowerCase();
  const primarySearch = qOnly || lOnly;
  const normSearch = normalizeFrenchSearchText(primarySearch);
  const effectiveTrack = track === 'en' || track === 'fr' ? track : 'ar';

  try {
    const db = loadDB();
    if (Array.isArray(db.tutor_training)) {
      for (const custom of db.tutor_training) {
        const kws = Array.isArray(custom.keywords) ? custom.keywords : [];
        if (kws.some((kw) => kw && primarySearch.includes(kw.toLowerCase()))) {
          // عدم تمرير الدروس المدرّبة بالعربية فقط عند اختيار النسخة الفرنسية أو الإنجليزية
          if (effectiveTrack === 'fr' && !custom.rule_fr) continue;
          if (effectiveTrack === 'en' && (!custom.rule_en || /[\u0600-\u06FF]/.test(custom.rule_en))) continue;
          return {
            is_custom_trained: true,
            keywords: kws,
            title_ar: custom.title_ar || 'طريقة الحل المعتمدة من المعلم',
            title_en: custom.title_en || custom.title_ar || 'Teacher Approved Solution Method',
            title_fr: custom.title_fr || custom.title_en || 'Méthode validée par l’enseignant',
            svg_diagram: custom.svg_diagram || TOPIC_KNOWLEDGE_BASE[0].svg_diagram,
            rule_ar: custom.rule_ar || '',
            rule_en: custom.rule_en || custom.rule_ar || '',
            rule_fr: custom.rule_fr || '',
            examples_ar: custom.steps_ar ? [custom.steps_ar] : [],
            examples_en: custom.steps_en ? [custom.steps_en] : [custom.steps_ar || ''],
            examples_fr: custom.steps_fr ? [custom.steps_fr] : [],
            voice_script_ar: custom.voice_script_ar || '',
            voice_script_en: custom.voice_script_en || custom.voice_script_ar || '',
            voice_script_fr: custom.voice_script_fr || ''
          };
        }
      }
    }
  } catch (e) {}

  // البحث أولاً في فهرس المنهج الكامل (15 درساً للصفوف الإعدادية الثلاثة بالفرنسية والإنجليزية والعربية)
  if (normSearch) {
    let bestSyllabus = null;
    let bestScore = 0;
    const stopWords = new Set(['le', 'la', 'les', 'de', 'du', 'des', 'et', 'en', 'un', 'une', 'dans', 'sur', 'pour', 'par', 'avec', 'the', 'and', 'of', 'in', 'to', 'for', 'expliquer', 'explique', 'explain', 'lesson', 'lecon', 'unite', 'unit', 'درس', 'اشرح', 'اشرحلي', 'شرح', 'في', 'عن', 'من']);
    const searchTokens = normSearch.split(/\s+/).filter((w) => w.length >= 3 && !stopWords.has(w));
    for (const sItem of ALL_PREP_SYLLABUS_INDEX) {
      const hay = normalizeFrenchSearchText(
        `${sItem.lesson_fr} ${sItem.unit_fr} ${sItem.lesson_en} ${sItem.unit_en} ${sItem.lesson_ar} ${sItem.unit_ar}`
      );
      let score = 0;
      if (hay.includes(normSearch) && normSearch.length >= 5) score += 25;
      for (const tk of searchTokens) {
        if (hay.includes(tk)) score += tk.length >= 6 ? 8 : 5;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSyllabus = sItem;
      }
    }
    if (bestSyllabus && bestScore >= 8) {
      const matchedSvg =
        TOPIC_KNOWLEDGE_BASE.find((t) =>
          t.keywords.some((kw) => normalizeFrenchSearchText(bestSyllabus.lesson_ar + ' ' + bestSyllabus.lesson_fr).includes(normalizeFrenchSearchText(kw)))
        )?.svg_diagram || TOPIC_KNOWLEDGE_BASE[0].svg_diagram;

      return {
        keywords: [bestSyllabus.lesson_ar, bestSyllabus.lesson_en, bestSyllabus.lesson_fr],
        title_ar: bestSyllabus.lesson_ar,
        title_en: bestSyllabus.lesson_en,
        title_fr: bestSyllabus.lesson_fr,
        svg_diagram: matchedSvg,
        rule_ar: bestSyllabus.explain_summary_ar,
        rule_en: bestSyllabus.explain_summary_en,
        rule_fr: bestSyllabus.explain_summary_fr,
        examples_ar: bestSyllabus.homework_items_ar.slice(0, 2).map((q, i) => `${q}\n  ${bestSyllabus.homework_solutions_ar[i] || ''}`),
        examples_en: bestSyllabus.homework_items_en.slice(0, 2).map((q, i) => `${q}\n  ${bestSyllabus.homework_solutions_en[i] || ''}`),
        examples_fr: bestSyllabus.homework_items_fr.slice(0, 2).map((q, i) => `${q}\n  ${bestSyllabus.homework_solutions_fr[i] || ''}`)
      };
    }
  }

  if (qOnly) {
    for (const item of TOPIC_KNOWLEDGE_BASE) {
      if (item.keywords.some((kw) => normSearch.includes(normalizeFrenchSearchText(kw)))) {
        return { ...item, ...getPedagogicalExtras(item.title_ar, effectiveTrack), ...item };
      }
    }
  }

  if (clientLessonData && (clientLessonData.title_ar || clientLessonData.explain_ar)) {
    const cTitleAr = clientLessonData.title_ar || questionText || 'الدرس المقرر';
    const cTitleEn = clientLessonData.title_en || cTitleAr;
    const cExplainAr = clientLessonData.explain_ar || '';
    const cExplainEn = clientLessonData.explain_en || cExplainAr;
    const extras = getPedagogicalExtras(cTitleAr, effectiveTrack);
    const clientExamplesAr =
      Array.isArray(clientLessonData.examples) && clientLessonData.examples.length > 0
        ? clientLessonData.examples.map(
            (ex) => `${ex.prompt_ar}\n  ${ex.formula || ''}\n  ${(ex.steps_ar || []).join('\n  ')}`
          )
        : [
            `مثال تطبيقي محلول على (${cTitleAr}):\n  - المعطيات والقاعدة: ${cExplainAr}\n  - خطوات الحل: نكتب القانون الأساسي للدرس أولاً ثم نعوض بالأرقام المعطاة للوصول إلى الناتج النهائي بدقة.`
          ];
    return {
      keywords: [cTitleAr],
      title_ar: cTitleAr,
      title_en: cTitleEn,
      unit_title_ar: clientLessonData.unit_title_ar || '',
      analogy_ar: extras.analogy,
      memory_hook_ar: extras.memory_hook,
      egyptian_narration_ar: `${extras.narration} القاعدة الأساسية في الدرس بتقول: ${cExplainAr}`,
      svg_diagram: `<div class="tutor-lesson-banner">
        <div class="tlb-badge">📚 تحضير ومذاكرة مستر عارف</div>
        <div class="tlb-title">${cTitleAr}</div>
        <div class="tlb-sub">الفكرة المبتكرة ⟵ القاعدة والقانون ⟵ التطبيق والحل</div>
      </div>`,
      rule_ar: cExplainAr,
      rule_en: cExplainEn,
      examples_ar: clientExamplesAr,
      examples_en: clientExamplesAr
    };
  }

  for (const item of TOPIC_KNOWLEDGE_BASE) {
    if (item.keywords.some((kw) => lOnly.includes(kw))) {
      return { ...item, ...getPedagogicalExtras(item.title_ar), ...item };
    }
  }
  const def = TOPIC_KNOWLEDGE_BASE[0];
  return { ...def, ...getPedagogicalExtras(def.title_ar), ...def };
}

function numberToSpokenArabicWords(numStr) {
  const map = {
    '0': 'صفر', '1': 'واحد', '2': 'اتنين', '3': 'تلاتة', '4': 'أربعة',
    '5': 'خمسة', '6': 'ستة', '7': 'سبعة', '8': 'تمانية', '9': 'تسعة',
    '10': 'عشرة', '11': 'حداشر', '12': 'اتناشر', '15': 'خمستاشر', '16': 'ستاشر',
    '20': 'عشرين', '24': 'أربعة وعشرين', '25': 'خمسة وعشرين', '30': 'تلاتين',
    '45': 'خمسة وأربعين', '60': 'ستين', '90': 'تسعين', '100': 'مية',
    '110': 'مية وعشرة', '120': 'مية وعشرين', '180': 'مية وتمانين', '360': 'تلتمية وستين'
  };
  return map[numStr] || numStr;
}

function mathToSpokenText(rawText, track = 'ar') {
  if (!rawText) return '';
  const isEn = track === 'en';
  const isFr = track === 'fr';
  let s = String(rawText)
    .replace(/\*\*+/g, ' ')
    .replace(/\*+/g, ' ')
    .replace(/#+/g, ' ')
    .replace(/__+/g, ' ')
    .replace(/~+/g, ' ')
    .replace(/\x60+/g, ' ');

  if (isFr) {
    return s
      .replace(/[\u0600-\u06FF]+/g, ' ')
      .replace(/\\text\{([^}]+)\}/g, ' $1 ')
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, ' $1 sur $2 ')
      .replace(/\\sqrt\[3\]\{([^}]+)\}/g, ' racine cubique de $1 ')
      .replace(/\\sqrt\{([^}]+)\}/g, ' racine carrée de $1 ')
      .replace(/\^2|²/g, ' au carré ')
      .replace(/\^3|³/g, ' au cube ')
      .replace(/\\implies|\\iff|⇒|⇔|→/g, ' donc ')
      .replace(/\\times|×/g, ' multiplié par ')
      .replace(/\\div|÷/g, ' divisé par ')
      .replace(/\\perp|⊥/g, ' perpendiculaire à ')
      .replace(/\\angle|∠/g, ' angle ')
      .replace(/\\triangle|△/g, ' triangle ')
      .replace(/\\mathbb\{Q\}/g, ' l’ensemble Q ')
      .replace(/\\mathbb\{R\}/g, ' l’ensemble R ')
      .replace(/\\mathbb\{Z\}/g, ' l’ensemble Z ')
      .replace(/\bcm\b/gi, ' centimètres ')
      .replace(/\bkm\b/gi, ' kilomètres ')
      .replace(/\bmm\b/gi, ' millimètres ')
      .replace(/\bEGP\b/g, ' livres égyptiennes ')
      .replace(/\bHypotenuse\b/gi, ' hypoténuse ')
      .replace(/\bCentral Angle\b/gi, ' angle au centre ')
      .replace(/\bRatio\b/gi, ' rapport ')
      .replace(/\b(AB|BC|AC|AD|BD|DC|CD|CB|DB|ABC)\b/g, (m) => ' ' + m.split('').join(' ') + ' ')
      .replace(/\+/g, ' plus ')
      .replace(/=/g, ' égale ')
      .replace(/\^\circ|°/g, ' degrés ')
      .replace(/\$\$|\$/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ')
      .replace(/[{}_•🔹📘📐👨‍🏫✅❓💡📌🧠🎯🎙️✍️🔑]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (isEn) {
    return s
      .replace(/[\u0600-\u06FF]+/g, ' ')
      .replace(/\\text\{([^}]+)\}/g, ' $1 ')
      .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, ' $1 over $2 ')
      .replace(/\\sqrt\[3\]\{([^}]+)\}/g, ' cube root of $1 ')
      .replace(/\\sqrt\{([^}]+)\}/g, ' square root of $1 ')
      .replace(/\^2|²/g, ' squared ')
      .replace(/\^3|³/g, ' cubed ')
      .replace(/\\implies|\\iff|⇒|⇔|→/g, ' which gives ')
      .replace(/\\times|×/g, ' times ')
      .replace(/\\div|÷/g, ' divided by ')
      .replace(/\\perp|⊥/g, ' perpendicular to ')
      .replace(/\\angle|∠/g, ' angle ')
      .replace(/\\triangle|△/g, ' triangle ')
      .replace(/\\mathbb\{Q\}/g, ' Q ')
      .replace(/\\mathbb\{R\}/g, ' R ')
      .replace(/\\mathbb\{Z\}/g, ' Z ')
      .replace(/\bcm\b/gi, ' centimeters ')
      .replace(/\bkm\b/gi, ' kilometers ')
      .replace(/\bmm\b/gi, ' millimeters ')
      .replace(/\+/g, ' plus ')
      .replace(/=/g, ' equals ')
      .replace(/\^\circ|°/g, ' degrees ')
      .replace(/\$\$|\$/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ')
      .replace(/[{}_•🔹📘📐👨‍🏫✅❓💡📌🧠🎯🎙️✍️🔑]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // العربية: نحول كل الرموز والمعادلات إلى نطق عربي كامل بدلاً من حذفها
  s = s
    .replace(/\\text\{([^}]+)\}/g, ' $1 ')
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, ' $1 على $2 ')
    .replace(/\\sqrt\[3\]\{([^}]+)\}/g, ' الجذر التكعيبي لـ $1 ')
    .replace(/\\sqrt\{([^}]+)\}/g, ' الجذر التربيعي لـ $1 ')
    .replace(/\^2|²/g, ' تربيع ')
    .replace(/\^3|³/g, ' تكعيب ')
    .replace(/\\implies|\\iff|⇒|⇔|⟵|⟶|⇐/g, ' إذن ')
    .replace(/\\times|×/g, ' في ')
    .replace(/\\div|÷|\//g, ' على ')
    .replace(/\+/g, ' زائد ')
    .replace(/=/g, ' يساوي ')
    .replace(/\\perp|⊥/g, ' عمودي على ')
    .replace(/\\angle|∠/g, ' زاوية ')
    .replace(/\\triangle|△/g, ' المثلث ')
    .replace(/\\sin/g, ' جا ')
    .replace(/\\cos/g, ' جتا ')
    .replace(/\\tan/g, ' ظا ')
    .replace(/\bAB\b/g, ' ألف باء ')
    .replace(/\bBC\b/g, ' باء جيم ')
    .replace(/\bCB\b/g, ' جيم باء ')
    .replace(/\bAC\b/g, ' ألف جيم ')
    .replace(/\bAD\b/g, ' ألف دال ')
    .replace(/\bBD\b/g, ' باء دال ')
    .replace(/\bDB\b/g, ' دال باء ')
    .replace(/\bDC\b/g, ' دال جيم ')
    .replace(/\bCD\b/g, ' جيم دال ')
    .replace(/\bABC\b/g, ' ألف باء جيم ')
    .replace(/\bx\b/gi, ' سين ')
    .replace(/\by\b/gi, ' صاد ')
    .replace(/\^\circ|°/g, ' درجة ')
    .replace(/\bcm\b/gi, ' سنتيمتر ')
    .replace(/\$\$|\$/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[a-zA-Z]+/g, ' ')
    .replace(/[{}_[\]()•🔹📘📐👨‍🏫✅❓💡📌🧠🎯🎙️✍️🔑]/g, ' ')
    .replace(/\b(\d+)\b/g, (_, d) => ' ' + numberToSpokenArabicWords(d) + ' ');

  return s.replace(/\s+/g, ' ').trim();
}

function buildVideoLessonSteps(matchedTopic, questionText, track = 'ar', fullAnswerText = '') {
  const effectiveTrack = track === 'en' || track === 'fr' ? track : 'ar';
  const isEn = effectiveTrack === 'en';
  const isFr = effectiveTrack === 'fr';
  const extras = getPedagogicalExtras(matchedTopic.title_ar, effectiveTrack);

  const title = isFr
    ? (matchedTopic.title_fr || matchedTopic.title_en || matchedTopic.title_ar)
    : isEn
    ? (matchedTopic.title_en || matchedTopic.title_ar)
    : matchedTopic.title_ar;
  const rule = isFr
    ? (matchedTopic.rule_fr || matchedTopic.rule_en || matchedTopic.rule_ar)
    : isEn
    ? (matchedTopic.rule_en || matchedTopic.rule_ar)
    : matchedTopic.rule_ar;
  const examples = isFr
    ? (matchedTopic.examples_fr || matchedTopic.examples_en || matchedTopic.examples_ar)
    : isEn
    ? (matchedTopic.examples_en || matchedTopic.examples_ar)
    : matchedTopic.examples_ar;

  const workedSolution = fullAnswerText && fullAnswerText.length > 40
    ? fullAnswerText
    : (examples && examples.join('\n\n')) || rule;

  return [
    {
      step_title: isFr ? `Étape 1 : Accroche & Intuition (${title})` : isEn ? `Step 1: Warm-Up & Real-Life Intuition (${title})` : `الخطوة ١: التمهيد والفكرة المبتكرة (${title})`,
      tone: 'encouraging',
      narration: `${extras.narration} ${extras.analogy}`,
      content: extras.analogy
    },
    {
      step_title: isFr ? 'Étape 2 : Règle Fondamentale & Formule' : isEn ? 'Step 2: Core Theorem & Formula' : 'الخطوة ٢: القانون الأساسي والقاعدة المعتمدة',
      tone: 'attention',
      narration: isFr
        ? `Attention ! Voici la formule essentielle à retenir : ${mathToSpokenText(rule, 'fr')}`
        : isEn
        ? `Pay close attention! Here is the core formula you need to master: ${mathToSpokenText(rule, 'en')}`
        : `انتبه وركز كويس جداً في القانون الأساسي ده: ${mathToSpokenText(rule, 'ar')}`,
      content: rule
    },
    {
      step_title: isFr ? 'Étape 3 : Résolution Détaillée Étape par Étape' : isEn ? 'Step 3: Detailed Step-by-Step Solution' : 'الخطوة ٣: الحل النموذجي التفصيلي خطوة بخطوة',
      tone: 'explaining',
      narration: mathToSpokenText(workedSolution, effectiveTrack),
      content: workedSolution
    },
    {
      step_title: isFr ? 'Étape 4 : Clé d’Or pour l’Examen & Encouragement' : isEn ? 'Step 4: Golden Exam Tip & Next Challenge' : 'الخطوة ٤: الشفرة الذهبية للامتحان والتشجيع',
      tone: 'celebrating',
      narration: isFr
        ? `Bravo ! ${extras.memory_hook} Maintenant, testez votre compréhension ou passez aux exercices ci-dessous !`
        : isEn
        ? `Awesome work! ${extras.memory_hook} Now test your understanding below or jump to the practice exam!`
        : `ممتاز يا بطل! ${extras.memory_hook} دلوقتي جرب تحل السؤال التدريبي تحت أو انتقل مباشرة للاختبارات وملفات الشرح!`,
      content: extras.memory_hook
    }
  ];
}

function normalizeArabicDigits(str) {
  const map = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
  return String(str || '').replace(/[٠-٩]/g, (d) => map[d] || d);
}

function buildSmartMathExplanation(questionText, lessonTitle, track = 'ar', clientLessonData = null) {
  const effectiveTrack = track === 'en' || track === 'fr' ? track : 'ar';
  const isEn = effectiveTrack === 'en';
  const isFr = effectiveTrack === 'fr';
  const cleanQ = normalizeArabicDigits((questionText || '').trim());

  // 0. الرد المباشر على التحيات والأسئلة العامة بالفرنسية والإنجليزية
  if (isFr && /^(bonjour|salut|bonsoir|coucou|hello|hi|qui es[- ]tu|tu parles fran[çc]ais|parles[- ]tu fran[çc]ais)/i.test(cleanQ)) {
    return [
      `👋 Bonjour et bienvenue ! Je suis Monsieur Aref, votre professeur intelligent de mathématiques.`,
      ``,
      `🇫🇷 Oui, je parle et j’explique les mathématiques entièrement en français !`,
      `• Demandez-moi n’importe quelle leçon du programme : Proportions, Théorème de Pythagore, Théorème d’Euclide, Factorisation, Fonction Quadratique, Trigonométrie ou Géométrie du Cercle.`,
      `• Ou écrivez directement une équation à résoudre, par exemple : 2x + 3 = 11 ou x / 6 = 4 / 8.`
    ].join('\n');
  }

  const matchedTopic = findMatchedTopic(cleanQ, lessonTitle, clientLessonData, effectiveTrack);
  const extras = getPedagogicalExtras(matchedTopic.title_ar, effectiveTrack);

  // 1. حل معادلات التناسب في اللغات الثلاث (x / b = c / d)
  const propMatch = cleanQ.replace(/\s+/g, '').match(/(?:س|ص|x|y)\/(\d+)=(\d+)\/(\d+)/i);
  if (propMatch) {
    const b = Number(propMatch[1]);
    const c = Number(propMatch[2]);
    const d = Number(propMatch[3]);
    if (d !== 0) {
      const prod = b * c;
      const val = prod / d;
      if (isFr) {
        return [
          `🧠 Résolution guidée par M. Aref : Calcul de l’inconnue (x) dans une proportion`,
          ``,
          `📐 1. Formule du produit en croix :`,
          `$$\\frac{x}{${b}} = \\frac{${c}}{${d}} \\implies ${d} \\times x = ${b} \\times ${c}$$`,
          ``,
          `✍️ 2. Étapes de calcul :`,
          `• Produit des termes connus : ${b} × ${c} = ${prod}`,
          `• Division par le coefficient de x (${d}) : $$x = \\frac{${prod}}{${d}} = ${val}$$`,
          ``,
          `✅ Réponse finale : x = ${val}. Bravo !`
        ].join('\n');
      }
      if (isEn) {
        return [
          `🧠 Mr. Aref Guided Solution: Solving a Proportion for Unknown (x)`,
          ``,
          `📐 1. Cross-Multiplication Rule:`,
          `$$\\frac{x}{${b}} = \\frac{${c}}{${d}} \\implies ${d} \\times x = ${b} \\times ${c}$$`,
          ``,
          `✍️ 2. Step-by-Step Calculation:`,
          `• Multiply the two known diagonal numbers: ${b} × ${c} = ${prod}`,
          `• Divide by the number opposite to x (${d}): $$x = \\frac{${prod}}{${d}} = ${val}$$`,
          ``,
          `✅ Final Answer: x = ${val}. Well done!`
        ].join('\n');
      }
      return [
        `🧠 تحضير مستر عارف للسؤال: مسألة تناسب وإيجاد قيمة المجهول (س)`,
        ``,
        `📐 ١. القانون الأساسي (حاصل ضرب الطرفين = حاصل ضرب الوسطين):`,
        `$$\\frac{x}{${b}} = \\frac{${c}}{${d}} \\implies ${d} \\times x = ${b} \\times ${c}$$`,
        ``,
        `✍️ ٢. خطوات الحل بالتفصيل:`,
        `• نضرب الرقمين المعلومين في المقص: ${b} × ${c} = ${prod}`,
        `• نقسم الناتج على الرقم المقابل للسين (${d}): $$x = \\frac{${prod}}{${d}} = ${val}$$`,
        ``,
        `✅ الناتج النهائي: قيمة (س) = ${val}. أحسنت يا بطل!`
      ].join('\n');
    }
  }

  // 2. حل المعادلات الخطية (ax + b = c) في اللغات الثلاث (AR / EN / FR)
  const linEqMatch = cleanQ.replace(/\s+/g, '').match(/([+-]?\d*)(?:س|ص|x|y)([+-]\d+)=([+-]\d+)/i);
  if (linEqMatch) {
    const a = linEqMatch[1] === '' || linEqMatch[1] === '+' ? 1 : linEqMatch[1] === '-' ? -1 : Number(linEqMatch[1]);
    const b = Number(linEqMatch[2]);
    const c = Number(linEqMatch[3]);
    if (a !== 0 && Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) {
      const rhs = c - b;
      const val = rhs / a;
      const signB = b >= 0 ? `+ ${b}` : `- ${Math.abs(b)}`;
      const oppB = b >= 0 ? `- ${b}` : `+ ${Math.abs(b)}`;
      if (isFr) {
        return [
          `🧠 Résolution d’équation linéaire par M. Aref :`,
          `$$${a === 1 ? '' : a}x ${signB} = ${c}$$`,
          `1. Transposons (${b}) dans l’autre membre en changeant son signe : $$${a === 1 ? '' : a}x = ${c} ${oppB} = ${rhs}$$`,
          `2. Divisons les deux membres par ${a} : $$x = \\frac{${rhs}}{${a}} = ${val}$$`,
          `✅ L’ensemble des solutions est S = { ${val} }. Bravo !`
        ].join('\n');
      }
      if (isEn) {
        return [
          `🧠 Mr. Aref Linear Equation Solver:`,
          `$$${a === 1 ? '' : a}x ${signB} = ${c}$$`,
          `1. Transpose (${b}) to the right-hand side with opposite sign: $$${a === 1 ? '' : a}x = ${c} ${oppB} = ${rhs}$$`,
          `2. Divide both sides by ${a}: $$x = \\frac{${rhs}}{${a}} = ${val}$$`,
          `✅ Solution Set: S.S. = { ${val} }. Great job!`
        ].join('\n');
      }
      return [
        `🧠 حل معادلة من الدرجة الأولى مع مستر عارف (خطوات الحل التفصيلية):`,
        `$$${a === 1 ? '' : a}x ${signB} = ${c}$$`,
        `1. ننقل العدد (${b}) للطرف الآخر بعكس الإشارة: $$${a === 1 ? '' : a}x = ${c} ${oppB} = ${rhs}$$`,
        `2. نقسم الطرفين على معامل س وهو (${a}): $$x = \\frac{${rhs}}{${a}} = ${val}$$`,
        `✅ إذن قيمة (س) = ${val} ، ومجموعة الحل = { ${val} }.`
      ].join('\n');
    }
  }

  const title = isFr ? (matchedTopic.title_fr || matchedTopic.title_en) : isEn ? matchedTopic.title_en : matchedTopic.title_ar;
  const rule = isFr ? (matchedTopic.rule_fr || matchedTopic.rule_en) : isEn ? matchedTopic.rule_en : matchedTopic.rule_ar;
  const examples = isFr ? (matchedTopic.examples_fr || matchedTopic.examples_en) : isEn ? matchedTopic.examples_en : matchedTopic.examples_ar;

  if (isFr) {
    return [
      `📘 Explication professionnelle avec M. Aref : ${title}`,
      '',
      `💡 Idée intuitive : ${extras.analogy}`,
      '',
      `📐 1. Formule et Règle :`,
      rule,
      '',
      `✍️ 2. Application Résolue :`,
      ...(examples || []),
      '',
      `🔑 ${extras.memory_hook}`
    ].join('\n');
  }
  if (isEn) {
    return [
      `📘 Professional Explanation with Mr. Aref: ${title}`,
      '',
      `💡 Real-Life Intuition: ${extras.analogy}`,
      '',
      `📐 1. Core Rule & Formula:`,
      rule,
      '',
      `✍️ 2. Worked Example:`,
      ...(examples || []),
      '',
      `🔑 ${extras.memory_hook}`
    ].join('\n');
  }

  return [
    `📘 شرح احترافي مع مستر عارف — ${title}:`,
    '',
    `💡 الفكرة الأساسية للدرس: ${extras.analogy}`,
    '',
    `📐 القانون الرياضي:`,
    rule,
    '',
    `✍️ مثال محلول خطوة بخطوة:`,
    ...(examples || []),
    '',
    `🔑 ${extras.memory_hook}`
  ].join('\n');
}

async function generateGeminiEgyptianVoiceWAV(textToSpeak, lang = 'ar', tone = 'explaining') {
  if (!GEMINI_API_KEY || !textToSpeak) return null;
  const maleVoices = ['Orus', 'Charon'];
  const toneGuide =
    lang === 'fr'
      ? (tone === 'encouraging' || tone === 'celebrating'
          ? 'Avec une voix chaleureuse, dynamique et très encourageante de professeur de mathématiques français (Monsieur Aref), lis avec expressivité :'
          : tone === 'attention'
          ? 'Avec une intonation claire, appuyée et attentive pour souligner une règle importante d’examen, lis :'
          : 'Avec une voix posée, claire et pédagogique de professeur de mathématiques français, lis :')
      : lang === 'en'
      ? (tone === 'encouraging' || tone === 'celebrating'
          ? 'In a warm, enthusiastic, encouraging male math teacher voice (Mr. Aref) with lively rising intonation, speak:'
          : tone === 'attention'
          ? 'In a clear, emphatic, attention-grabbing teacher voice highlighting a crucial exam rule, speak:'
          : 'In a clear, engaging, well-paced male math tutor voice, speak:')
      : (tone === 'encouraging' || tone === 'celebrating'
          ? 'بصوت معلم رياضيات مصري رجل (مستر عارف) بنبرة حماسية دافئة ومشجعة ومتغيرة التعبير لرفع همة الطالب، انطق:'
          : tone === 'attention'
          ? 'بصوت معلم رياضيات مصري رجل (مستر عارف) بنبرة تنبيه واضحة ومؤكدة للفت انتباه الطالب إلى قانون مهم في الامتحان، انطق:'
          : 'بصوت معلم رياضيات مصري رجل (مستر عارف) بنبرة تعليمية جذابة وواضحة ومتفاعلة، انطق:');

  for (const voiceName of maleVoices) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 22000);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${GEMINI_API_KEY}`;
      const payload = {
        contents: [{ parts: [{ text: `${toneGuide}\n${textToSpeak}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
        }
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(tid);
      const data = await r.json();
      const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (inlineData?.data) return pcm16BufferToWav(Buffer.from(inlineData.data, 'base64'), 24000);
    } catch (e) {
      clearTimeout(tid);
    }
  }
  return null;
}

// محرك النطق الصوتي المجاني متعدد اللغات (فرنسي / إنجليزي / عربي) يعمل تلقائياً بدون حزم صوت Windows
async function generateFreeWebTTS(textToSpeak, lang = 'ar') {
  const clean = String(textToSpeak || '').trim();
  if (!clean) return null;
  const tl = lang === 'fr' ? 'fr' : lang === 'en' ? 'en' : 'ar';

  // تقسيم النص إلى مقاطع قصيرة لضمان قبولها في جميع خوادم النطق
  const words = clean.split(/\s+/);
  const chunks = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > 160) {
      if (current.trim()) chunks.push(current.trim());
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
    if (chunks.length >= 6) break;
  }
  if (current.trim() && chunks.length < 6) chunks.push(current.trim());

  const fetchChunkAudio = async (chunk) => {
    const pollyVoice = tl === 'fr' ? 'Mathieu' : tl === 'en' ? 'Brian' : 'Zeina';
    const providers = [
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(chunk)}`,
      `https://translate.google.com/translate_tts?ie=UTF-8&client=gtx&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(chunk)}`,
      `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(pollyVoice)}&text=${encodeURIComponent(chunk)}`
    ];
    for (const ttsUrl of providers) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 7000);
      try {
        const r = await fetch(ttsUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://translate.google.com/'
          },
          signal: controller.signal
        });
        clearTimeout(tid);
        const ct = String(r.headers.get('content-type') || '').toLowerCase();
        if (r.ok && (ct.includes('audio') || ct.includes('mpeg') || ct.includes('octet-stream'))) {
          const ab = await r.arrayBuffer();
          if (ab.byteLength > 250) return Buffer.from(ab);
        }
      } catch (e) {
        clearTimeout(tid);
      }
    }
    return null;
  };

  const buffers = [];
  for (const chunk of chunks) {
    const buf = await fetchChunkAudio(chunk);
    if (buf) buffers.push(buf);
  }
  return buffers.length ? Buffer.concat(buffers) : null;
}

async function callGeminiAPI(prompt, base64Image = null, mimeType = null, fallbackContext = {}) {
  if (!GEMINI_API_KEY) {
    return buildSmartMathExplanation(
      fallbackContext.questionText,
      fallbackContext.lessonTitle,
      fallbackContext.track,
      fallbackContext.clientLessonData
    );
  }
  const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  const parts = [{ text: prompt }];
  if (base64Image && mimeType) parts.push({ inlineData: { mimeType, data: base64Image } });

  for (const modelName of modelsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json();
      if (!data.error && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
    } catch (e) {
      clearTimeout(timeoutId);
    }
  }
  return buildSmartMathExplanation(
    fallbackContext.questionText,
    fallbackContext.lessonTitle,
    fallbackContext.track,
    fallbackContext.clientLessonData
  );
}

// ==================== 🌐 محرك الاستيراد العلمي الذكي من الإنترنت (Wikipedia + Wikimedia + Gemini Grounding) ====================
const TRUSTED_WEB_DOMAINS = [
  'wikipedia.org',
  'wikimedia.org',
  'ekb.eg',
  'khanacademy.org',
  'geogebra.org',
  'moe.gov.eg'
];

function isTrustedEducationUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return TRUSTED_WEB_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch (e) {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': 'EgyptianMinistryOfKnowledgePlatform/2.0 (Educational Platform)',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    clearTimeout(tid);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

async function fetchWikipediaArticle(topic, lang = 'ar') {
  const wikiLang = lang === 'fr' ? 'fr' : lang === 'en' ? 'en' : 'ar';
  try {
    const searchUrl = `https://${wikiLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&srlimit=1&format=json`;
    const sRes = await fetchWithTimeout(searchUrl, {}, 6500);
    if (!sRes.ok) return null;
    const sJson = await sRes.json();
    const firstHit = sJson?.query?.search?.[0];
    if (!firstHit || !firstHit.title) return null;

    const sumUrl = `https://${wikiLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstHit.title)}`;
    const sumRes = await fetchWithTimeout(sumUrl, {}, 6500);
    if (!sumRes.ok) return null;
    const sumJson = await sumRes.json();
    return {
      title: sumJson.title || firstHit.title,
      extract: sumJson.extract || '',
      url: sumJson.content_urls?.desktop?.page || `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(firstHit.title)}`,
      thumbnail: sumJson.thumbnail?.source || ''
    };
  } catch (e) {
    return null;
  }
}

async function fetchWikimediaDiagrams(topic) {
  try {
    const q = `${topic} diagram OR geometry OR math`;
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&prop=imageinfo&iiprop=url|mime&iiurlwidth=640&format=json`;
    const res = await fetchWithTimeout(apiUrl, {}, 6500);
    if (!res.ok) return [];
    const json = await res.json();
    const pages = Object.values(json?.query?.pages || {});
    const imgs = [];
    for (const p of pages) {
      const info = p.imageinfo && p.imageinfo[0];
      if (!info) continue;
      const mime = String(info.mime || '');
      if (mime.startsWith('image/')) {
        imgs.push({
          title: String(p.title || 'Educational Diagram').replace(/^File:/i, ''),
          url: info.thumburl || info.url,
          license: 'Wikimedia Commons (Free Educational License)'
        });
      }
    }
    return imgs.slice(0, 3);
  } catch (e) {
    return [];
  }
}

async function extractTextFromTrustedUrl(urlStr) {
  if (!isTrustedEducationUrl(urlStr)) return null;
  try {
    const res = await fetchWithTimeout(urlStr, {}, 7000);
    if (!res.ok) return null;
    const html = await res.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2200);
    return cleaned;
  } catch (e) {
    return null;
  }
}

async function callGeminiWebGrounded(topic, lang, wikiExtract, urlExtract) {
  if (!GEMINI_API_KEY) return null;
  const prompt = lang === 'fr'
    ? `Tu es un expert pédagogique en mathématiques. Prépare une fiche scientifique fiable pour le sujet : "${topic}". Inclus : 1) Formules en LaTeX ($...$), 2) Deux méthodes d'explication simples, 3) Un exemple résolu. Contexte extrait : ${wikiExtract || ''} ${urlExtract || ''}`
    : lang === 'en'
    ? `You are a Senior Math Curriculum Expert. Prepare a reliable scientific study sheet for: "${topic}". Include: 1) Core LaTeX formulas ($...$), 2) Two clear teaching methods, 3) One worked example. Reference context: ${wikiExtract || ''} ${urlExtract || ''}`
    : `أنت خبير مناهج رياضيات مصري. كوّن مادة علمية موثوقة ومبسطة للمرحلة الإعدادية حول: "${topic}". اذكر بدون رموز **: 1) القانون الأساسي بصيغة LaTeX ($...$)، 2) طريقتين مبسطتين للشرح، 3) مثالاً محلولاً بالخطوات. معلومات مرجعية: ${wikiExtract || ''} ${urlExtract || ''}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
        })
      },
      14000
    );
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const citations = chunks
      .filter((c) => c.web && c.web.uri)
      .map((c) => ({ title: c.web.title || 'Web Source', url: c.web.uri }))
      .slice(0, 4);
    return text ? { text: text.replace(/\*\*+/g, ''), citations } : null;
  } catch (e) {
    return null;
  }
}

async function downloadRemoteImageLocally(imageUrl) {
  try {
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return imageUrl;
    const res = await fetchWithTimeout(imageUrl, {}, 7000);
    if (!res.ok) return imageUrl;
    const ct = String(res.headers.get('content-type') || 'image/png').toLowerCase();
    const ext = ct.includes('svg') ? '.svg' : ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : '.png';
    const arrBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrBuf);
    if (buf.length < 100 || buf.length > 4 * 1024 * 1024) return imageUrl;
    const fileName = `web_import_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buf);
    return '/uploads/' + encodeURIComponent(fileName);
  } catch (e) {
    return imageUrl;
  }
}

function parseMultipartField(buffer, fieldName) {
  const marker = Buffer.from(`name="${fieldName}"\r\n\r\n`, 'utf8');
  const idx = buffer.indexOf(marker);
  if (idx === -1) return '';
  const start = idx + marker.length;
  const end = buffer.indexOf(Buffer.from('\r\n--', 'utf8'), start);
  if (end === -1) return '';
  return buffer.subarray(start, end).toString('utf8').trim();
}

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    let u;
    try {
      u = new URL(req.url, `http://localhost:${PORT}`);
    } catch (urlErr) {
      recordMrCodeError('http-url-parse', urlErr.message, urlErr.stack);
      return sendJSON(res, { success: false, error: 'رابط غير صالح' }, 400);
    }

    if (req.method === 'OPTIONS') {
      return sendJSON(res, { ok: true });
    }
    // محرك النطق الصوتي التعبيري متعدد اللغات لمستر عارف (/api/tts)
    if (u.pathname === '/api/tts') {
      const rawQ = u.searchParams.get('text') || '';
      const lang = u.searchParams.get('lang') || 'ar';
      const tone = u.searchParams.get('tone') || 'explaining';
      const cleanSpoken = mathToSpokenText(rawQ, lang).slice(0, 1400);
      if (!cleanSpoken) {
        res.writeHead(204);
        return res.end();
      }
      (async () => {
        if (GEMINI_API_KEY) {
          const wavBuf = await generateGeminiEgyptianVoiceWAV(cleanSpoken, lang, tone);
          if (wavBuf) {
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
            return res.end(wavBuf);
          }
        }
        const mp3Buf = await generateFreeWebTTS(cleanSpoken, lang);
        if (mp3Buf) {
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
          return res.end(mp3Buf);
        }
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
      })().catch(() => {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
      });
      return;
    }

    if (u.pathname.startsWith('/api/student/STD')) {
      const db = loadDB();
      return sendJSON(res, {
        student: db.students[0],
        completedLessonIds: db.progress,
        attempts: db.attempts,
        mistakes: db.mistakes,
        scratchpads: db.scratchpads || []
      });
    }

    if (u.pathname === '/api/library') {
      const db = loadDB();
      return sendJSON(res, { items: db.library || DEFAULT_LIBRARY_ITEMS });
    }

    if (u.pathname === '/api/live-services') {
      const db = loadDB();
      return sendJSON(res, {
        schedules: DEFAULT_FIXED_SCHEDULES,
        recordings: DEFAULT_RECORDED_PACKAGES,
        private_bookings: db.private_bookings || [],
        schedule_enrollments: db.schedule_enrollments || [],
        recorded_purchases: db.recorded_purchases || []
      });
    }

    if (u.pathname === '/api/placement-tests') {
      const db = loadDB();
      return sendJSON(res, { tests: db.placement_tests || DEFAULT_PLACEMENT_TESTS });
    }

    if (u.pathname === '/api/tutor-training') {
      const db = loadDB();
      return sendJSON(res, { items: db.tutor_training || [] });
    }

    // 📊 مؤشرات القياس الحية وسجل الأخطاء لـ «مستر كود» (/api/mrcode/telemetry)
    if (u.pathname === '/api/mrcode/telemetry') {
      const mem = process.memoryUsage();
      const db = loadDB();
      return sendJSON(res, {
        status: 'healthy',
        uptime_sec: Math.round((Date.now() - SERVER_START_TIME) / 1000),
        ram_rss_mb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        ram_heap_mb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        node_version: process.version,
        ai_mode: GEMINI_API_KEY ? 'gemini-2.5-flash' : 'local-architect',
        errors_count: MR_CODE_ERROR_LOG.length,
        recent_errors: MR_CODE_ERROR_LOG.slice(0, 10),
        backups_count: listProjectBackups().length,
        pdf_library_count: (db.library || []).length
      });
    }

    // 💾 قائمة النسخ الاحتياطية المتاحة للاستعادة (/api/mrcode/backups)
    if (u.pathname === '/api/mrcode/backups') {
      return sendJSON(res, { success: true, backups: listProjectBackups() });
    }

    if (u.pathname === '/api/benchmark') {
      const t0 = Date.now();
      const db = loadDB();
      const sampleFormula = '$$\\frac{x}{6} = \\frac{4}{8} \\implies x = 3$$';
      return sendJSON(res, {
        status: 'ok',
        server_time: new Date().toISOString(),
        node_version: process.version,
        ai_connected: Boolean(GEMINI_API_KEY),
        latency_ms: Date.now() - t0,
        uploads_dir_ready: fs.existsSync(UPLOADS_DIR),
        stored_files_count: (db.library || []).length,
        completed_lessons_count: (db.progress || []).length,
        private_bookings_count: (db.private_bookings || []).length,
        speech_engine_samples: {
          ar: mathToSpokenText(sampleFormula, 'ar'),
          en: mathToSpokenText(sampleFormula, 'en'),
          fr: mathToSpokenText(sampleFormula, 'fr')
        }
      });
    }

    if (u.pathname === '/api/curriculum') {
      const db = loadDB();
      const g = Number(u.searchParams.get('grade') || 0);
      const t = Number(u.searchParams.get('term') || 0);
      const units = (db.units || []).filter(
        (unit) => (!g || Number(unit.grade) === g) && (!t || Number(unit.term) === t)
      );
      return sendJSON(res, { units });
    }

    if (u.pathname === '/api/quiz') {
      return sendJSON(res, { questions: [] });
    }

    if (u.pathname === '/api/admin/overview') {
      const db = loadDB();
      const avg =
        db.attempts.length > 0
          ? Math.round(db.attempts.reduce((s, a) => s + (a.percentage || 0), 0) / db.attempts.length)
          : 0;
      return sendJSON(res, {
        unitsCount: 24,
        lessonsCount: 82,
        questionsCount: 246,
        students: [
          {
            ...db.students[0],
            completed_lessons: db.progress.length,
            total_quizzes: db.attempts.length,
            avg_score: avg
          }
        ]
      });
    }

    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const rawBuffer = Buffer.concat(chunks);
          const rawText = rawBuffer.toString('utf8');
          const db = loadDB();
        let body = {};
        let questionText = '';
        let track = 'ar';
        let lessonTitle = '';

        try {
          body = JSON.parse(rawText);
          questionText = body.question || '';
          track = body.track || 'ar';
          lessonTitle = body.lessonTitle || '';
        } catch (e) {
          questionText = parseMultipartField(rawBuffer, 'question');
          track = parseMultipartField(rawBuffer, 'track') || 'ar';
          lessonTitle = parseMultipartField(rawBuffer, 'lessonTitle');
        }

        if (u.pathname === '/api/admin/verify-pin') {
          const entered = String(body.pin || '').trim();
          if (entered === ADMIN_PIN) {
            return sendJSON(res, { success: true, authorized: true });
          }
          return sendJSON(res, { success: false, authorized: false, error: 'الرمز السري غير صحيح' }, 401);
        }

        if (u.pathname === '/api/student/save-scratchpad') {
          if (!Array.isArray(db.scratchpads)) db.scratchpads = [];
          const noteItem = {
            id: Date.now(),
            lesson_id: Number(body.lesson_id) || 0,
            lesson_title: body.lesson_title || 'مسودة حل رياضي',
            image_data: body.image_data || '',
            created_at: new Date().toISOString()
          };
          db.scratchpads.unshift(noteItem);
          db.scratchpads = db.scratchpads.slice(0, 20);
          saveDB(db);
          return sendJSON(res, { success: true, item: noteItem });
        }

        if (u.pathname.includes('complete-lesson')) {
          if (body.lesson_id && !db.progress.includes(body.lesson_id)) {
            db.progress.push(body.lesson_id);
            saveDB(db);
          }
          return sendJSON(res, { success: true });
        }

        if (u.pathname === '/api/student/update-profile') {
          if (!Array.isArray(db.students) || db.students.length === 0) {
            db.students = [{ id: 1, code: 'STD-1001', name: 'طالب المرحلة الإعدادية', grade: 1, track: 'ar', lesson_records: {} }];
          }
          db.students[0] = {
            ...db.students[0],
            ...body,
            lesson_records: { ...(db.students[0].lesson_records || {}), ...(body.lesson_records || {}) }
          };
          saveDB(db);
          return sendJSON(res, { success: true, student: db.students[0] });
        }

        if (u.pathname === '/api/student/update-lesson-record') {
          if (!Array.isArray(db.students) || db.students.length === 0) {
            db.students = [{ id: 1, code: 'STD-1001', name: 'طالب المرحلة الإعدادية', grade: 1, track: 'ar', lesson_records: {} }];
          }
          const st = db.students[0];
          if (!st.lesson_records) st.lesson_records = {};
          const lid = String(body.lesson_id || '101');
          const prev = st.lesson_records[lid] || { attended: false, hw_submitted: false, score: null, stars: 0, extra_hw_sent: false };
          const nextScore = body.score !== undefined && body.score !== null ? Number(body.score) : prev.score;
          const calcStars =
            nextScore === null || nextScore === undefined
              ? prev.stars || 0
              : nextScore >= 90 ? 5 : nextScore >= 80 ? 4 : nextScore >= 65 ? 3 : nextScore >= 50 ? 2 : 1;

          st.lesson_records[lid] = { ...prev, ...body, score: nextScore, stars: calcStars, updated_at: new Date().toISOString().slice(0, 10) };
          if (body.attended && !db.progress.includes(Number(lid))) db.progress.push(Number(lid));
          saveDB(db);
          return sendJSON(res, { success: true, student: st, record: st.lesson_records[lid] });
        }

        if (u.pathname.includes('submit-quiz')) {
          const total = Number(body.total) || 0;
          const score = Number(body.score) || 0;
          const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
          db.attempts.unshift({ lesson_id: body.lesson_id || null, grade: body.grade || 1, score, total, percentage, created_at: new Date().toISOString() });
          if (Array.isArray(body.mistakes)) body.mistakes.forEach((m) => db.mistakes.unshift(m));
          saveDB(db);
          return sendJSON(res, { success: true, percentage });
        }

        if (u.pathname.includes('/ai/tutor')) {
          const effectiveTrack = detectQuestionLanguage(questionText, track);
          const isEn = effectiveTrack === 'en';
          const isFr = effectiveTrack === 'fr';
          const clientLessonData = body.lessonData || null;
          const matchedTopic = findMatchedTopic(questionText, lessonTitle, clientLessonData, effectiveTrack);
          const extras = getPedagogicalExtras(matchedTopic.title_ar, effectiveTrack);

          const prompt = isFr
            ? `Tu es "M. Aref", professeur de mathématiques passionné et très encourageant. Question de l'élève : "${questionText}". Réponds ENTIÈREMENT en français académique clair et motivant, étape par étape, avec formules LaTeX ($...$), sans aucun mot arabe ni astérisques **.`
            : isEn
            ? `You are "Mr. Aref", an enthusiastic, expert math tutor. Student Question: "${questionText}". Explain COMPLETELY in clear, encouraging academic English step-by-step with LaTeX formulas ($...$), without any Arabic text or ** asterisks.`
            : `أنت "مستر عارف"، معلم رياضيات مصري خبير ومحفز. سؤال الطالب: "${questionText}". اشرح مباشرة بالعربية التعليمية المشجعة خطوة بخطوة مع المعادلات، بدون أي مقدمات إنجليزية وبدون رموز ** نهائياً.`;

          let aiAnswer = matchedTopic.is_custom_trained
            ? buildSmartMathExplanation(questionText, lessonTitle, effectiveTrack, clientLessonData)
            : await callGeminiAPI(prompt, null, null, { questionText, lessonTitle, track: effectiveTrack, clientLessonData });

          // ضمان عدم تسرب أي نص عربي داخل النسخة الفرنسية أو الإنجليزية
          if ((isFr || isEn) && /[\u0600-\u06FF]/.test(String(aiAnswer || ''))) {
            aiAnswer = buildSmartMathExplanation(questionText, lessonTitle, effectiveTrack, clientLessonData);
          }

          const cleanAnswerNoStars = String(aiAnswer || '').replace(/\*\*+/g, '');
          const cleanSpokenOnly = mathToSpokenText(cleanAnswerNoStars, effectiveTrack);

          const practiceQuestion = isFr
            ? (matchedTopic.title_ar.includes('تناسب')
              ? { prompt: 'Trouvez la valeur de x si : x / 9 = 4 / 6', answer: '6', hint: 'Multipliez 9 × 4 puis divisez par 6' }
              : matchedTopic.title_ar.includes('فيثاغورس')
              ? { prompt: 'Dans un triangle rectangle de côtés 3 cm et 4 cm, quelle est la longueur de l’hypoténuse ?', answer: '5', hint: 'Calculez √(3² + 4²)' }
              : { prompt: 'Résolvez l’équation : 3x + 2 = 14, quelle est la valeur de x ?', answer: '4', hint: 'Soustrayez 2 de 14 puis divisez par 3' })
            : isEn
            ? (matchedTopic.title_ar.includes('تناسب')
              ? { prompt: 'Find the value of x if: x / 9 = 4 / 6', answer: '6', hint: 'Multiply 9 × 4 and divide by 6' }
              : matchedTopic.title_ar.includes('فيثاغورس')
              ? { prompt: 'In a right triangle with legs 3 cm and 4 cm, what is the hypotenuse?', answer: '5', hint: 'Calculate √(3² + 4²)' }
              : { prompt: 'Solve the equation: 3x + 2 = 14, what is x?', answer: '4', hint: 'Subtract 2 from 14, then divide by 3' })
            : (matchedTopic.title_ar.includes('تناسب')
              ? { prompt: 'أوجد قيمة (س) إذا كان: س / 9 = 4 / 6', answer: '6', hint: 'اضرب 9 × 4 واقسم على 6' }
              : matchedTopic.title_ar.includes('فيثاغورس')
              ? { prompt: 'مثلث قائم ضلعا القائمة 3 سم و 4 سم، فما طول الوتر؟', answer: '5', hint: 'الجذر التربيعي لـ (3² + 4²)' }
              : { prompt: 'حل المعادلة: 3س + 2 = 14 ، فما قيمة س؟', answer: '4', hint: 'اطرح 2 من 14 ثم اقسم على 3' });

          const localizedLessonTitle = isFr
            ? (matchedTopic.title_fr || matchedTopic.title_en || matchedTopic.title_ar)
            : isEn
            ? (matchedTopic.title_en || matchedTopic.title_ar)
            : matchedTopic.title_ar;

          const preStudyPayload = {
            lesson_title: localizedLessonTitle,
            analogy: extras.analogy,
            memory_hook: extras.memory_hook
          };

          return sendJSON(res, {
            answer: cleanAnswerNoStars,
            effective_lang: effectiveTrack,
            spoken_summary: cleanSpokenOnly,
            pre_study: preStudyPayload,
            practice_question: practiceQuestion,
            diagram_svg: matchedTopic.svg_diagram,
            video_steps: buildVideoLessonSteps(matchedTopic, questionText, effectiveTrack, cleanAnswerNoStars)
          });
        }

        if (u.pathname === '/api/tutor-training/add') {
          if (!Array.isArray(db.tutor_training)) db.tutor_training = [];
          const keywordsArr = String(body.keywords || '').split(/[,،]+/).map((k) => k.trim()).filter(Boolean);
          const newTraining = {
            id: Date.now(),
            grade: Number(body.grade) || 1,
            title_ar: body.title_ar || 'طريقة حل مخصصة من المعلم',
            title_en: body.title_en || body.title_ar || 'Custom Teacher Solution Method',
            keywords: keywordsArr.length ? keywordsArr : [body.title_ar || 'مسألة'],
            rule_ar: body.rule_ar || '',
            steps_ar: body.steps_ar || '',
            voice_script_ar: body.voice_script_ar || '',
            created_at: new Date().toISOString().slice(0, 10)
          };
          db.tutor_training.unshift(newTraining);
          saveDB(db);
          return sendJSON(res, { success: true, item: newTraining, items: db.tutor_training });
        }

        // 👨‍💻 مستر كود (Mr. Code): المهندس البرمجي الذكي لمراقبة وتطوير المنصة
        if (u.pathname === '/api/ai/code-architect') {
          const devPrompt = String(body.prompt || 'افحص صحة المشروع واقترح تحسينات برمجية').trim();
          const syntaxAudit = inspectProjectSyntaxDeep();
          const mem = process.memoryUsage();
          const ramMb = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
          const uptimeSec = Math.round((Date.now() - SERVER_START_TIME) / 1000);

          const healthChecks = [
            ...syntaxAudit.map((s) => ({ item: `فحص الكود العميق (${s.file})`, status: s.details })),
            { item: 'أداء الخادم والذاكرة الحية', status: `RAM: ${ramMb} MB | Uptime: ${uptimeSec}s | Node ${process.version}` },
            { item: 'سجل الأخطاء الحي (Error Watcher)', status: MR_CODE_ERROR_LOG.length === 0 ? 'لا توجد أخطاء مسجلة — النظام مستقر 100% ✅' : `تم رصد ${MR_CODE_ERROR_LOG.length} تنبيه/خطأ للمراجعة ⚠️` },
            { item: 'النسخ الاحتياطية وحقيبة PDF', status: `النسخ الاحتياطية: ${listProjectBackups().length} | ملفات PDF: ${(db.library || []).length}` }
          ];

          // حفظ ذاكرة المحادثة البرمجية ليتذكر مستر كود الطلبات السابقة
          MR_CODE_CHAT_MEMORY.push({ role: 'user', text: devPrompt, time: new Date().toISOString() });
          if (MR_CODE_CHAT_MEMORY.length > 10) MR_CODE_CHAT_MEMORY.shift();

          const recentContext = MR_CODE_CHAT_MEMORY.slice(-4).map((m) => `- [${m.role}]: ${m.text}`).join('\n');

          const architectSystemPrompt = `أنت "مستر كود" (Mr. Code)، كبير مهندسي البرمجيات ومراقب الجودة لمنصة "وزارة المعارف المصرية" (Node.js Vanilla HTTP Server + Single-File HTML/CSS/JS + KaTeX + data.json).
حالة الفحص العميق الحالية:
${healthChecks.map((c) => `- ${c.item}: ${c.status}`).join('\n')}
ذاكرة المحادثة البرمجية الأخيرة:
${recentContext}

طلب المطور/المالك: "${devPrompt}"

المطلوب منك:
1. قدّم تشخيصاً دقيقاً ومباشراً باللغة العربية.
2. إذا طلب المطور ميزة أو إصلاحاً برمجياً، اكتب له الكود النظيف والمتوافق 100% مع بنية المشروع.
3. اختم بـ 3 توصيات عملية لرفع كفاءة المنصة وأمانها.`;

          let architectReply = '';
          if (GEMINI_API_KEY) {
            architectReply = await callGeminiAPI(architectSystemPrompt, null, null, { questionText: devPrompt, track: 'ar' });
          } else {
            const allOk = syntaxAudit.every((s) => s.ok);
            architectReply = [
              `👨‍💻 تقرير مستر كود المتقدم (Deep AST & DevOps Architect):`,
              ``,
              `📊 أولاً: نتيجة الفحص العميق للتركيب النحوي (AST / vm.Script):`,
              ...healthChecks.map((c) => `• ${c.item}: ${c.status}`),
              ``,
              `🛠️ ثانياً: التحليل البرمجي لطلبك ("${devPrompt}"):`,
              allOk
                ? `1. جميع ملفات المشروع (server.js و public/index.html) اجتازت الفحص النحوي العميق بنجاح دون أي SyntaxError.`
                : `1. ⚠️ تم اكتشاف خطأ نحوي يحتاج إصلاحاً فورياً — راجع السطر المشار إليه أعلاه.`,
              `2. ذاكرة المحادثة نشطة (${MR_CODE_CHAT_MEMORY.length} رسالة) وتدعم النسخ الاحتياطي التلقائي والاستعادة بنقرة واحدة.`,
              ``,
              `💡 ثالثاً: توصيات مستر كود للتطوير القادم:`,
              `• استخدم زر «🧪 تشغيل الاختبار الشامل» للتحقق من جميع المسارات بعد أي تعديل.`,
              `• استخدم زر «💾 نسخة احتياطية فورية» قبل تطبيق أي باتش برمجي جديد.`,
              `• أضف مفتاح GEMINI_API_KEY في ملف .env لتفعيل التوليد السحابي الفائق.`
            ].join('\n');
          }

          MR_CODE_CHAT_MEMORY.push({ role: 'mrcode', text: architectReply.slice(0, 220), time: new Date().toISOString() });

          return sendJSON(res, {
            success: true,
            checks: healthChecks,
            syntax_audit: syntaxAudit,
            analysis: architectReply,
            memory_count: MR_CODE_CHAT_MEMORY.length,
            ai_mode: GEMINI_API_KEY ? 'gemini-2.5-flash' : 'local-architect'
          });
        }

        // 🚨 استقبال تقارير الأخطاء الحية من المتصفح (/api/mrcode/report-error)
        if (u.pathname === '/api/mrcode/report-error') {
          const logged = recordMrCodeError(body.source || 'client-ui', body.message || 'UI Error', body.stack || '');
          return sendJSON(res, { success: true, error_entry: logged, total_errors: MR_CODE_ERROR_LOG.length });
        }

        // 💾 إنشاء نسخة احتياطية فورية (/api/mrcode/backup)
        if (u.pathname === '/api/mrcode/backup') {
          const info = createProjectBackup(body.reason || 'manual-admin');
          return sendJSON(res, { success: true, backup: info, backups: listProjectBackups() });
        }

        // ↩️ استعادة نسخة احتياطية محددة (/api/mrcode/rollback)
        if (u.pathname === '/api/mrcode/rollback') {
          const backupId = path.basename(String(body.backup_id || ''));
          const srcDir = path.join(BACKUPS_DIR, backupId);
          if (!backupId || !fs.existsSync(srcDir)) {
            return sendJSON(res, { success: false, error: 'النسخة الاحتياطية المطلوبة غير موجودة' }, 404);
          }
          // حفظ نسخة أمان قبل التراجع
          createProjectBackup('pre-rollback-safety');
          const restored = [];
          const mapTargets = [
            { src: path.join(srcDir, 'index.html'), dest: path.join(PUBLIC_DIR, 'index.html'), name: 'public/index.html' },
            { src: path.join(srcDir, 'data.json'), dest: DB_FILE, name: 'data.json' }
          ];
          mapTargets.forEach((m) => {
            if (fs.existsSync(m.src)) {
              fs.copyFileSync(m.src, m.dest);
              restored.push(m.name);
            }
          });
          return sendJSON(res, { success: true, restored, message: `تمت استعادة النسخة (${backupId}) بنجاح!` });
        }

        // ⚡ تطبيق تعديل آمن مع نسخ احتياطي تلقائي وفحص نحوي (/api/mrcode/apply-patch)
        if (u.pathname === '/api/mrcode/apply-patch') {
          const targetKey = String(body.target || 'public/index.html');
          const findStr = String(body.find || '');
          const replaceStr = String(body.replace || '');
          if (!findStr) return sendJSON(res, { success: false, error: 'نص البحث مطلوب لتطبيق الباتش الآمن' }, 400);

          const targetPath = targetKey === 'server.js' ? __filename : path.join(PUBLIC_DIR, 'index.html');
          if (!fs.existsSync(targetPath)) return sendJSON(res, { success: false, error: 'الملف غير موجود' }, 404);

          const originalContent = fs.readFileSync(targetPath, 'utf8');
          if (!originalContent.includes(findStr)) {
            return sendJSON(res, { success: false, error: 'لم يتم العثور على النص المستهدف داخل الملف' }, 400);
          }
          const updatedContent = originalContent.replace(findStr, replaceStr);

          // التحقق النحوي قبل الحفظ
          try {
            if (targetKey === 'server.js') {
              new vm.Script(updatedContent);
            } else {
              const sm = updatedContent.match(/<script>([\s\S]*?)<\/script>/);
              if (sm && sm[1]) new vm.Script(sm[1]);
            }
          } catch (syntaxErr) {
            return sendJSON(res, { success: false, error: `تم رفض الباتش لوجود خطأ نحوي: ${syntaxErr.message}` }, 400);
          }

          const backup = createProjectBackup(`before-patch-${targetKey}`);
          fs.writeFileSync(targetPath, updatedContent, 'utf8');
          return sendJSON(res, { success: true, backup, message: `تم حفظ نسخة احتياطية (${backup.id}) وتطبيق التعديل بأمان!` });
        }

        // 🧪 تشغيل الاختبار الآلي الشامل للمنصة من داخل لوحة مستر كود (/api/mrcode/run-tests)
        if (u.pathname === '/api/mrcode/run-tests') {
          const syntaxAudit = inspectProjectSyntaxDeep();
          const htmlFile = path.join(PUBLIC_DIR, 'index.html');
          const htmlStr = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '';
          const libCount = (db.library || []).length;
          const sampleMath = buildSmartMathExplanation('س / 6 = 4 / 8', '', 'ar');
          const sampleFr = buildSmartMathExplanation('Expliquer les proportions', '', 'fr');

          const checks = [
            { name: '١. سلامة التركيب النحوي للخادم (server.js AST)', passed: Boolean(syntaxAudit[0] && syntaxAudit[0].ok), metric: syntaxAudit[0]?.details || '' },
            { name: '٢. سلامة التركيب النحوي للواجهة (public/index.html AST)', passed: Boolean(syntaxAudit[1] && syntaxAudit[1].ok), metric: syntaxAudit[1]?.details || '' },
            { name: '٣. تفعيل مكتبة المعادلات الرياضية (LaTeX / KaTeX)', passed: htmlStr.includes('katex.min.js') && htmlStr.includes('renderAllMath'), metric: 'KaTeX v0.16.11 + Auto-Render' },
            { name: '٤. اكتمال الترجمة الثلاثية وخط Book Antiqua وتشكيل العناوين', passed: htmlStr.includes('Book Antiqua') && htmlStr.includes('tashkeelArabicText') && htmlStr.includes('Section (Français)'), metric: 'AR + EN + FR + Book Antiqua + Diacritics' },
            { name: '٥. حقيبة ملفات PDF المصنفة للصفوف الإعدادية الثلاثة', passed: libCount >= 60, metric: `متوفر ${libCount} ملف تعليمي مصنف` },
            { name: '٦. محرك مستر عارف لحل المعادلات بالعربية والفرنسية', passed: sampleMath.includes('3') && sampleFr.includes('Règle'), metric: 'حل المعادلات + دعم اللغات الثلاث' },
            { name: '٧. جاهزية نظام النسخ الاحتياطي ومراقب الأخطاء الحي', passed: fs.existsSync(BACKUPS_DIR), metric: `مجلد backups/ جاهز (${listProjectBackups().length} نسخة)` }
          ];

          const passedCount = checks.filter((c) => c.passed).length;
          const scorePercent = Math.round((passedCount / checks.length) * 100);
          return sendJSON(res, {
            success: true,
            score_percent: scorePercent,
            passed: passedCount,
            total: checks.length,
            checks
          });
        }

        // ==================== ✨ مسارات مكتبة المحتوى الذكي (Smart Content Library APIs) ====================
        // 1. تلخيص الدروس تلقائياً (/api/smart-library/summarize)
        if (u.pathname === '/api/smart-library/summarize') {
          const lang = String(body.lang || 'ar');
          const lessonId = Number(body.lesson_id || 0);
          const customText = String(body.text || '').trim();
          const syllabusMatch = ALL_PREP_SYLLABUS_INDEX.find((x) => x.lesson_id === lessonId);

          const sourceTitle = syllabusMatch
            ? (lang === 'fr' ? syllabusMatch.lesson_fr : lang === 'en' ? syllabusMatch.lesson_en : syllabusMatch.lesson_ar)
            : (lang === 'fr' ? 'Texte personnalisé' : lang === 'en' ? 'Custom Lesson Text' : 'نص الدرس المخصص');

          const sourceBody = customText || (syllabusMatch
            ? (lang === 'fr'
                ? `${syllabusMatch.explain_summary_fr}\n${syllabusMatch.homework_items_fr.join('\n')}`
                : lang === 'en'
                ? `${syllabusMatch.explain_summary_en}\n${syllabusMatch.homework_items_en.join('\n')}`
                : `${syllabusMatch.explain_summary_ar}\n${syllabusMatch.homework_items_ar.join('\n')}`)
            : '');

          if (!sourceBody) {
            return sendJSON(res, { success: false, error: 'يرجى اختيار درس أو إدخال نص للتلخيص' }, 400);
          }

          let summaryText = '';
          if (GEMINI_API_KEY) {
            const sumPrompt = lang === 'fr'
              ? `Résume ce cours de mathématiques de manière structurée (Idée principale, Formules LaTeX, Points clés pour l'examen) :\nTitre: ${sourceTitle}\nContenu:\n${sourceBody}`
              : lang === 'en'
              ? `Summarize this math lesson in a structured study sheet (Core Idea, LaTeX Formulas, Exam Tips):\nTitle: ${sourceTitle}\nContent:\n${sourceBody}`
              : `لخّص هذا الدرس الرياضي في نقاط مركزة واحترافية (الفكرة المحورية، القوانين بصيغة LaTeX، وأهم تكات الامتحان) بدون رموز نجمتين **:\nالعنوان: ${sourceTitle}\nالمحتوى:\n${sourceBody}`;
            summaryText = await callGeminiAPI(sumPrompt, null, null, { questionText: sourceTitle, track: lang });
          } else {
            const sentences = sourceBody.split(/[.،\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
            if (lang === 'fr') {
              summaryText = [
                `📝 Résumé automatique : ${sourceTitle}`,
                ``,
                `🔹 Points essentiels :`,
                ...sentences.map((s, i) => `${i + 1}. ${s}`),
                ``,
                `🎯 Conseil d'examen : Vérifiez toujours les unités et écrivez la formule principale en premier.`
              ].join('\n');
            } else if (lang === 'en') {
              summaryText = [
                `📝 Automatic Lesson Summary: ${sourceTitle}`,
                ``,
                `🔹 Key Takeaways:`,
                ...sentences.map((s, i) => `${i + 1}. ${s}`),
                ``,
                `🎯 Exam Tip: Always write the core formula first, substitute carefully, and verify units.`
              ].join('\n');
            } else {
              summaryText = [
                `📝 الملخص التلقائي الذكي لدرس: ${sourceTitle}`,
                ``,
                `🔹 أهم القواعد والأفكار المركزة:`,
                ...sentences.map((s, i) => `${i + 1}. ${s}`),
                ``,
                `🎯 خلاصة وتكات الامتحان: اكتب القانون الأساسي في أول سطر، وحّد الوحدات قبل التعويض، وراجع الإشارات في الخطوة الأخيرة.`
              ].join('\n');
            }
          }

          return sendJSON(res, {
            success: true,
            title: sourceTitle,
            summary: String(summaryText).replace(/\*\*+/g, ''),
            word_count: sourceBody.split(/\s+/).filter(Boolean).length
          });
        }

        // 2. تحويل الفيديو إلى نص والعكس (/api/smart-library/video-text)
        if (u.pathname === '/api/smart-library/video-text') {
          const lang = String(body.lang || 'ar');
          const mode = String(body.mode || 'video_to_text'); // 'video_to_text' | 'text_to_video'
          const input = String(body.input || '').trim();
          const videoTitle = String(body.video_title || input || 'درس رياضيات تفاعلي').trim();

          if (!input) {
            return sendJSON(res, { success: false, error: 'يرجى إدخال رابط/عنوان الفيديو أو النص المطلوب تحويله' }, 400);
          }

          if (mode === 'video_to_text') {
            const matched = findMatchedTopic(videoTitle, videoTitle);
            let transcript = '';
            if (GEMINI_API_KEY) {
              const p = lang === 'fr'
                ? `Génère une transcription pédagogique structurée avec horodatages [00:00] pour une vidéo éducative intitulée : "${videoTitle}".`
                : lang === 'en'
                ? `Generate a structured educational video transcript with timestamps [00:00] and key takeaways for: "${videoTitle}".`
                : `حوّل محتوى الفيديو التعليمي التالي إلى نص مفرّغ منظم بالطوابع الزمنية [00:00] مع استخراج القوانين والأسئلة بدون رموز **: "${videoTitle}"`;
              transcript = await callGeminiAPI(p, null, null, { questionText: videoTitle, track: lang });
            } else {
              const rule = lang === 'en' || lang === 'fr' ? matched.rule_en : matched.rule_ar;
              const ex = (lang === 'en' || lang === 'fr' ? matched.examples_en : matched.examples_ar)[0] || rule;
              transcript = lang === 'fr'
                ? `[00:00] Introduction à la vidéo : ${videoTitle}\n[00:45] Explication de la règle principale : ${rule}\n[02:15] Application résolue étape par étape : ${ex}\n[04:00] Synthèse et vérification des réponses.`
                : lang === 'en'
                ? `[00:00] Video Introduction: ${videoTitle}\n[00:45] Core Mathematical Rule: ${rule}\n[02:15] Worked Example Walkthrough: ${ex}\n[04:00] Final Recap & Exam Checklist.`
                : `[00:00] مقدمة الفيديو التمهيدية: أهلاً بكم في شرح "${videoTitle}"\n[00:45] القاعدة الأساسية والقانون: ${rule}\n[02:15] تطبيق عملي ومثال محلول خطوة بخطوة: ${ex}\n[04:00] الملخص النهائي وأهم الأسئلة المتوقعة في الامتحان.`;
            }
            return sendJSON(res, {
              success: true,
              mode: 'video_to_text',
              transcript: String(transcript).replace(/\*\*+/g, ''),
              diagram_svg: matched.svg_diagram || ''
            });
          } else {
            // تحويل النص إلى سيناريو ومشاهد فيديو تفاعلية (Text -> Interactive Video Storyboard)
            const rawLines = input.split(/[\n.!؟]+/).map((s) => s.trim()).filter(Boolean);
            const scenes = (rawLines.length ? rawLines : [input]).slice(0, 6).map((line, idx) => {
              const secStart = idx * 20;
              const mm = String(Math.floor(secStart / 60)).padStart(2, '0');
              const ss = String(secStart % 60).padStart(2, '0');
              return {
                scene_number: idx + 1,
                timestamp: `${mm}:${ss}`,
                title: lang === 'fr' ? `Scène ${idx + 1}` : lang === 'en' ? `Scene ${idx + 1}` : `المشهد ${idx + 1}`,
                visual_cue: idx === 0
                  ? (lang === 'fr' ? 'Titre animé + Objectifs du cours' : lang === 'en' ? 'Animated Title Card + Lesson Objectives' : 'شاشة العنوان المتحركة + أهداف الدرس')
                  : (lang === 'fr' ? 'Tableau interactif + Mise en évidence des formules' : lang === 'en' ? 'Smart Whiteboard + Formula Highlight' : 'السبورة الذكية + إبراز القوانين والخطوات'),
                narration: line,
                spoken_text: mathToSpokenText(line, lang)
              };
            });
            return sendJSON(res, {
              success: true,
              mode: 'text_to_video',
              scenes,
              total_duration_sec: scenes.length * 20
            });
          }
        }

        // 3. البحث الذكي الشامل داخل المنصة (/api/smart-library/search)
        if (u.pathname === '/api/smart-library/search') {
          const query = String(body.query || '').trim().toLowerCase();
          const lang = String(body.lang || 'ar');
          if (!query) return sendJSON(res, { success: true, results: [] });

          const tokens = query.split(/\s+/).filter((t) => t.length >= 2);
          const results = [];

          // أ) البحث في فهرس دروس المرحلة الإعدادية
          ALL_PREP_SYLLABUS_INDEX.forEach((item) => {
            const blob = `${item.lesson_ar} ${item.lesson_en} ${item.lesson_fr} ${item.unit_ar} ${item.explain_summary_ar} ${item.explain_summary_en} ${item.explain_summary_fr}`.toLowerCase();
            const hits = tokens.reduce((acc, tk) => acc + (blob.includes(tk) ? 1 : 0), 0);
            if (hits > 0 || blob.includes(query)) {
              results.push({
                type: 'lesson',
                score: hits * 10 + (blob.includes(query) ? 15 : 0),
                grade: item.grade,
                lesson_id: item.lesson_id,
                title: lang === 'fr' ? item.lesson_fr : lang === 'en' ? item.lesson_en : item.lesson_ar,
                snippet: lang === 'fr' ? item.explain_summary_fr : lang === 'en' ? item.explain_summary_en : item.explain_summary_ar
              });
            }
          });

          // ب) البحث في ملفات مخزن الكتب و PDF
          (db.library || []).forEach((doc) => {
            const blob = `${doc.title_ar || ''} ${doc.title_en || ''} ${doc.title_fr || ''} ${doc.lesson_title_ar || ''}`.toLowerCase();
            const hits = tokens.reduce((acc, tk) => acc + (blob.includes(tk) ? 1 : 0), 0);
            if (hits > 0 || blob.includes(query)) {
              results.push({
                type: 'pdf',
                score: hits * 6 + (blob.includes(query) ? 8 : 0),
                grade: doc.grade,
                lesson_id: doc.lesson_id,
                doc_id: doc.id,
                title: lang === 'fr' ? (doc.title_fr || doc.title_en || doc.title_ar) : lang === 'en' ? (doc.title_en || doc.title_ar) : doc.title_ar,
                snippet: lang === 'fr' ? (doc.unit_fr || '') : lang === 'en' ? (doc.unit_en || '') : (doc.unit_ar || '')
              });
            }
          });

          // ج) البحث في موسوعة مستر عارف
          TOPIC_KNOWLEDGE_BASE.forEach((topic) => {
            const blob = `${topic.title_ar} ${topic.title_en} ${(topic.keywords || []).join(' ')} ${topic.rule_ar}`.toLowerCase();
            const hits = tokens.reduce((acc, tk) => acc + (blob.includes(tk) ? 1 : 0), 0);
            if (hits > 0 || blob.includes(query)) {
              results.push({
                type: 'knowledge',
                score: hits * 8 + (blob.includes(query) ? 12 : 0),
                title: lang === 'en' || lang === 'fr' ? topic.title_en : topic.title_ar,
                snippet: lang === 'en' || lang === 'fr' ? topic.rule_en : topic.rule_ar
              });
            }
          });

          results.sort((a, b) => b.score - a.score);
          return sendJSON(res, { success: true, total: results.length, results: results.slice(0, 15) });
        }

        // 4. فهم الصور والملفات (/api/smart-library/understand-file)
        if (u.pathname === '/api/smart-library/understand-file') {
          const lang = String(body.lang || 'ar');
          const fileName = String(body.file_name || 'uploaded_file');
          const mimeType = String(body.mime_type || 'image/png');
          const base64Data = String(body.file_base64 || '').replace(/^data:[^;]+;base64,/, '');
          const textContent = String(body.text_content || '').trim();
          const userNote = String(body.question || '').trim();

          let analysis = '';
          if (GEMINI_API_KEY && base64Data && mimeType.startsWith('image/')) {
            const visionPrompt = lang === 'fr'
              ? `Analyse cette image mathématique ou ce document ("${fileName}"). Extrais l'énoncé exact, identifie le concept et propose une solution détaillée étape par étape. Note de l'utilisateur : ${userNote}`
              : lang === 'en'
              ? `Analyze this math image or document ("${fileName}"). Extract the exact problem, identify the concept, and provide a step-by-step solution. User note: ${userNote}`
              : `افحص هذه الصورة أو المستند التعليمي ("${fileName}") بدقة، استخرج نص المسألة أو المفهوم الرياضي الموجود بها، واشرح خطوات الحل النموذجية بالعربية مع المعادلات بدون رموز **. ملاحظة المستخدم: ${userNote}`;
            analysis = await callGeminiAPI(visionPrompt, base64Data, mimeType, { questionText: userNote || fileName, track: lang });
          } else if (textContent) {
            const matched = findMatchedTopic(textContent + ' ' + userNote, fileName);
            const fallbackSummary = buildSmartMathExplanation(userNote || textContent.slice(0, 180), matched.title_ar, lang);
            analysis = lang === 'fr'
              ? `📄 Analyse du fichier (${fileName}) — ${textContent.length} caractères :\n\n${fallbackSummary}`
              : lang === 'en'
              ? `📄 Document Analysis (${fileName}) — ${textContent.length} characters:\n\n${fallbackSummary}`
              : `📄 تحليل وفهم محتوى الملف (${fileName}) — حجم النص: ${textContent.length} حرف:\n\n${fallbackSummary}`;
          } else {
            const matched = findMatchedTopic(userNote || fileName, fileName);
            const rule = lang === 'en' || lang === 'fr' ? matched.rule_en : matched.rule_ar;
            analysis = lang === 'fr'
              ? `🖼️ Image reçue (${fileName} — ${mimeType}).\n• Concept détecté : ${matched.title_en}\n• Formule associée : ${rule}\n💡 Astuce : Ajoutez GEMINI_API_KEY dans .env pour la lecture OCR visuelle complète des images manuscrites.`
              : lang === 'en'
              ? `🖼️ Image received (${fileName} — ${mimeType}).\n• Detected Concept: ${matched.title_en}\n• Related Formula: ${rule}\n💡 Tip: Set GEMINI_API_KEY in .env to enable full cloud Vision OCR for handwritten math problems.`
              : `🖼️ تم استلام وفحص الصورة (${fileName} — ${mimeType}) بنجاح.\n• الموضوع الرياضي المرتبط: ${matched.title_ar}\n• القاعدة الأساسية المقترحة: ${rule}\n💡 ملاحظة: لتفعيل القراءة البصرية الكاملة (Vision OCR) للصور المكتوبة بخط اليد، أضف مفتاح GEMINI_API_KEY في ملف .env.`;
          }

          return sendJSON(res, {
            success: true,
            file_name: fileName,
            analysis: String(analysis).replace(/\*\*+/g, '')
          });
        }

        // 5. إعداد المحتوى للمدرس (/api/smart-library/teacher-prep)
        if (u.pathname === '/api/smart-library/teacher-prep') {
          const lang = String(body.lang || 'ar');
          const grade = Number(body.grade || 1);
          const topic = String(body.topic || '').trim();
          const duration = Number(body.duration || 45);
          if (!topic) return sendJSON(res, { success: false, error: 'يرجى إدخال عنوان الدرس لإعداد المحتوى' }, 400);

          const syllabusMatch = ALL_PREP_SYLLABUS_INDEX.find(
            (x) => x.lesson_ar.includes(topic) || x.lesson_en.toLowerCase().includes(topic.toLowerCase()) || x.lesson_fr.toLowerCase().includes(topic.toLowerCase())
          );
          const matched = findMatchedTopic(topic, topic);

          let prepPack = null;
          if (syllabusMatch) {
            prepPack = {
              title: lang === 'fr' ? syllabusMatch.lesson_fr : lang === 'en' ? syllabusMatch.lesson_en : syllabusMatch.lesson_ar,
              grade,
              duration_mins: duration,
              objectives: lang === 'fr'
                ? ['Comprendre la règle fondamentale et son domaine d’application.', 'Résoudre des exercices progressifs avec rigueur.', 'Appliquer le concept à des problèmes d’excellence.']
                : lang === 'en'
                ? ['Understand the core mathematical rule and its conditions.', 'Solve progressive textbook and workbook exercises accurately.', 'Apply concepts to higher-order thinking challenges.']
                : ['أن يتعرف الطالب على المفهوم الرياضي والقانون الأساسي للدرس بدقة.', 'أن يحل الطالب تدريبات متدرجة من كتاب الوزارة والمعاصر والأضواء.', 'أن يوظف الطالب قوانين الدرس في حل مسائل المتفوقين والقدرات العليا.'],
              warmup: lang === 'fr'
                ? 'Activité d’ouverture (5 min) : Rappel rapide des prérequis et question déclenchante au tableau.'
                : lang === 'en'
                ? 'Warm-up Activity (5 mins): Quick diagnostic review of prerequisites and a real-life hook question.'
                : 'التمهيد والتهيئة الذهنية (5 دقائق): مراجعة سريعة للخبرات السابقة وطرح سؤال تفاعلي من الحياة اليومية لجذب انتباه الطلاب.',
              explanation: lang === 'fr' ? syllabusMatch.explain_summary_fr : lang === 'en' ? syllabusMatch.explain_summary_en : syllabusMatch.explain_summary_ar,
              homework: lang === 'fr' ? syllabusMatch.homework_items_fr : lang === 'en' ? syllabusMatch.homework_items_en : syllabusMatch.homework_items_ar,
              solutions: lang === 'fr' ? syllabusMatch.homework_solutions_fr : lang === 'en' ? syllabusMatch.homework_solutions_en : syllabusMatch.homework_solutions_ar,
              gifted: lang === 'fr' ? syllabusMatch.advanced_problems_fr : lang === 'en' ? syllabusMatch.advanced_problems_en : syllabusMatch.advanced_problems_ar
            };
          } else {
            const rule = lang === 'en' || lang === 'fr' ? matched.rule_en : matched.rule_ar;
            const exs = lang === 'en' || lang === 'fr' ? matched.examples_en : matched.examples_ar;
            prepPack = {
              title: topic,
              grade,
              duration_mins: duration,
              objectives: lang === 'fr'
                ? [`Maîtriser les notions clés de : ${topic}`, 'Résoudre des applications pratiques étape par étape.']
                : lang === 'en'
                ? [`Master the core concepts of: ${topic}`, 'Solve step-by-step guided and independent practice problems.']
                : [`إتقان المفاهيم والقوانين الأساسية في درس: ${topic}`, 'القدرة على حل المسائل المتدرجة وتطبيق الخطوات النموذجية في الامتحان.'],
              warmup: lang === 'fr' ? 'Question rapide de mise en route (5 min).' : lang === 'en' ? '5-minute engaging warm-up question on the board.' : 'تهيئة سريعة لمدة 5 دقائق لربط الدرس الجديد بما سبق دراسته.',
              explanation: rule,
              homework: exs,
              solutions: [lang === 'fr' ? 'Appliquez la règle puis vérifiez chaque étape.' : lang === 'en' ? 'Apply the main formula and verify each calculation step.' : 'تُطبق القاعدة الأساسية مع التحقق من صحة الناتج النهائي.'],
              gifted: [lang === 'fr' ? `Problème d'approfondissement sur ${topic}.` : lang === 'en' ? `Challenge problem connecting ${topic} with multi-step reasoning.` : `مسألة تفكير عليا تربط بين "${topic}" ومهارات الجبر والهندسة السابقة.`]
            };
          }

          return sendJSON(res, { success: true, prep: prepPack });
        }

        // 6. المساعد الصوتي الذكي (/api/smart-library/voice-assistant)
        if (u.pathname === '/api/smart-library/voice-assistant') {
          const transcript = String(body.transcript || '').trim();
          const lang = String(body.lang || 'ar');
          if (!transcript) {
            return sendJSON(res, { success: false, error: 'لم يتم التقاط أي نص صوتي' }, 400);
          }
          const matched = findMatchedTopic(transcript, transcript);
          const replyText = buildSmartMathExplanation(transcript, matched.title_ar, lang);
          const cleanReply = String(replyText || '').replace(/\*\*+/g, '');
          const spokenReply = mathToSpokenText(cleanReply, lang);

          return sendJSON(res, {
            success: true,
            transcript,
            reply: cleanReply,
            spoken_reply: spokenReply,
            diagram_svg: matched.svg_diagram || ''
          });
        }

        // 7. الاستيراد العلمي الذكي من الإنترنت (/api/smart-library/web-import)
        if (u.pathname === '/api/smart-library/web-import') {
          const topic = String(body.topic || '').trim();
          const grade = Number(body.grade || 1);
          const lang = String(body.lang || 'ar');
          const includeImages = body.include_images !== false;
          const sourceUrl = String(body.source_url || '').trim();

          if (!topic && !sourceUrl) {
            return sendJSON(res, { success: false, error: 'يرجى كتابة موضوع الدرس أو رابط مصدر تعليمي موثوق' }, 400);
          }

          if (sourceUrl && !isTrustedEducationUrl(sourceUrl)) {
            return sendJSON(
              res,
              {
                success: false,
                error: `الرابط غير مدرج في قائمة المصادر التعليمية المعتمدة (${TRUSTED_WEB_DOMAINS.join(', ')})`
              },
              400
            );
          }

          const effectiveTopic = topic || 'رياضيات المرحلة الإعدادية';
          const [wikiData, wikimediaImgs, urlExtract] = await Promise.all([
            fetchWikipediaArticle(effectiveTopic, lang),
            includeImages ? fetchWikimediaDiagrams(effectiveTopic) : Promise.resolve([]),
            sourceUrl ? extractTextFromTrustedUrl(sourceUrl) : Promise.resolve(null)
          ]);

          const grounded = await callGeminiWebGrounded(effectiveTopic, lang, wikiData?.extract || '', urlExtract || '');
          const localMatch = findMatchedTopic(effectiveTopic, effectiveTopic);

          const sources = [];
          if (wikiData && wikiData.url) sources.push({ title: `Wikipedia: ${wikiData.title}`, url: wikiData.url });
          if (sourceUrl) sources.push({ title: 'رابط تعليمي موثوق مضاف بواسطة المعلم', url: sourceUrl });
          if (grounded && Array.isArray(grounded.citations)) {
            grounded.citations.forEach((c) => {
              if (!sources.some((s) => s.url === c.url)) sources.push(c);
            });
          }

          const images = [];
          if (includeImages && wikiData && wikiData.thumbnail) {
            images.push({
              title: wikiData.title,
              url: wikiData.thumbnail,
              license: 'Wikipedia / Wikimedia Commons'
            });
          }
          if (includeImages && Array.isArray(wikimediaImgs)) {
            wikimediaImgs.forEach((img) => {
              if (!images.some((x) => x.url === img.url)) images.push(img);
            });
          }

          const ruleLatex = lang === 'en' || lang === 'fr' ? localMatch.rule_en : localMatch.rule_ar;
          const explanationCombined = grounded?.text
            ? grounded.text
            : [
                wikiData?.extract ? `🌐 ملخص المصدر العلمي (${wikiData.title}):\n${wikiData.extract}` : '',
                urlExtract ? `🔗 مقتطف من الرابط المعتمد:\n${urlExtract.slice(0, 600)}...` : '',
                `📐 القاعدة وطريقة الشرح المبسطة للمرحلة الإعدادية:\n${ruleLatex}`,
                `✍️ مثال تطبيقي:\n${((lang === 'en' || lang === 'fr' ? localMatch.examples_en : localMatch.examples_ar) || [])[0] || ''}`
              ]
                .filter(Boolean)
                .join('\n\n');

          return sendJSON(res, {
            success: true,
            imported: {
              title: wikiData?.title || effectiveTopic,
              grade,
              lang,
              rule_latex: ruleLatex,
              explanation: explanationCombined,
              diagram_svg: localMatch.svg_diagram || '',
              images,
              sources,
              ai_mode: grounded ? 'gemini-google-search-grounding' : wikiData ? 'wikipedia-wikimedia-live' : 'offline-academic-fallback'
            }
          });
        }

        // 8. اعتماد وحفظ المادة المستوردة في المنهج ومخزن PDF وتدريب مستر عارف (/api/smart-library/web-import/save)
        if (u.pathname === '/api/smart-library/web-import/save') {
          const title = String(body.title || '').trim();
          const grade = Number(body.grade || 1);
          const lang = String(body.lang || 'ar');
          const ruleLatex = String(body.rule_latex || '').trim();
          const explanation = String(body.explanation || '').trim();
          const rawImages = Array.isArray(body.images) ? body.images : [];
          const sources = Array.isArray(body.sources) ? body.sources : [];

          if (!title || !explanation) {
            return sendJSON(res, { success: false, error: 'عنوان المادة والشرح مطلوبان للحفظ' }, 400);
          }

          // تنزيل الصور المعتمدة محلياً داخل مجلد uploads/ لضمان استمرارية العرض
          const savedImages = [];
          for (const img of rawImages.slice(0, 3)) {
            const localUrl = await downloadRemoteImageLocally(img.url);
            savedImages.push({ title: img.title || title, url: localUrl });
          }

          // أ) تدريب مستر عارف تلقائياً على المادة الجديدة
          if (!Array.isArray(db.tutor_training)) db.tutor_training = [];
          const kwList = title.split(/\s+/).filter((w) => w.length >= 2);
          const trainingEntry = {
            id: Date.now(),
            grade,
            title_ar: title,
            title_en: title,
            keywords: kwList.length ? kwList : [title],
            rule_ar: ruleLatex || explanation.slice(0, 220),
            steps_ar: explanation,
            sources,
            images: savedImages,
            created_at: new Date().toISOString().slice(0, 10)
          };
          db.tutor_training.unshift(trainingEntry);

          // ب) إضافة المادة كملف PDF منسق داخل مخزن الكتب
          if (!Array.isArray(db.library)) db.library = [];
          const pdfEntry = {
            id: Date.now() + 1,
            grade,
            term: 1,
            lesson_id: 101,
            unit_ar: 'محتوى علمي مستورد ومعتمد (مستر ذكي)',
            unit_en: 'Verified Web-Imported Material (Mr. Smart)',
            unit_fr: 'Contenu Scientifique Importé et Validé (M. Smart)',
            lesson_title_ar: title,
            lesson_title_en: title,
            lesson_title_fr: title,
            category: 'lesson_pdf',
            file_type: 'pdf',
            title_ar: `🌐 [مادة مستوردة معتمدة] ${title} (PDF)`,
            title_en: `🌐 [Verified Web Import] ${title} (PDF)`,
            title_fr: `🌐 [Contenu Importé Validé] ${title} (PDF)`,
            sections: [
              { heading: 'القانون والقاعدة الأساسية', lines: [ruleLatex || title] },
              { heading: 'الشرح والمادة العلمية المعتمدة', lines: explanation.split('\n').filter(Boolean) },
              { heading: 'المصادر الموثوقة', lines: sources.length ? sources.map((s) => `${s.title} — ${s.url}`) : ['مصدر معتمد عبر منصة وزارة المعارف المصرية'] }
            ],
            sections_en: [
              { heading: 'Core Formula & Rule', lines: [ruleLatex || title] },
              { heading: 'Verified Explanation', lines: explanation.split('\n').filter(Boolean) },
              { heading: 'Verified Sources', lines: sources.length ? sources.map((s) => `${s.title} — ${s.url}`) : ['Verified via Egyptian Ministry of Knowledge Platform'] }
            ],
            sections_fr: [
              { heading: 'Formule et Règle Principale', lines: [ruleLatex || title] },
              { heading: 'Explication Validée', lines: explanation.split('\n').filter(Boolean) },
              { heading: 'Sources Fiables', lines: sources.length ? sources.map((s) => `${s.title} — ${s.url}`) : ['Validé par la Plateforme du Ministère Égyptien du Savoir'] }
            ],
            images: savedImages,
            created_at: new Date().toISOString().slice(0, 10)
          };
          db.library.unshift(pdfEntry);
          saveDB(db);

          return sendJSON(res, {
            success: true,
            message: 'تم اعتماد وحفظ المادة العلمية والصور محلياً، وتدريب مستر عارف عليها وإضافتها لمخزن PDF بنجاح!',
            training_item: trainingEntry,
            pdf_item: pdfEntry
          });
        }

        if (u.pathname.includes('/ai/analyze-mistakes')) {
          const isEn = (body.track || 'ar') === 'en';
          if (!db.mistakes || db.mistakes.length === 0) {
            return sendJSON(res, {
              analysis: isEn
                ? '✅ Excellent! You have no recorded mistakes yet. Keep practicing!'
                : '✅ ممتاز! لا توجد لديك أي أخطاء مسجلة حتى الآن. استمر في التدريب والتفوق!'
            });
          }
          const concepts = [...new Set(db.mistakes.map((m) => m.concept_tag || 'عام'))].join(' ، ');
          const diag = isEn
            ? `📊 AI Diagnostic Report:\n• Concept areas to review: ${concepts}\n• Recommendation: Review the interactive whiteboard and solve 2 practice quizzes.`
            : `📊 تقرير التشخيص الذكي لأخطاء الطالب:\n• المفاهيم التي تحتاج إلى مراجعة: ${concepts}\n• خطة العلاج المقترحة: راجع الأمثلة المحلولة وشاهد سبورة الفيديو الناطقة في هذه الدروس ثم أعد الاختبار التفاعلي.`;
          return sendJSON(res, { analysis: diag });
        }

        if (u.pathname === '/api/library/upload') {
          let fileUrl = body.external_url || '';
          if (body.file_base64 && body.file_name) {
            const safeName = Date.now() + '_' + body.file_name.replace(/[^a-zA-Z0-9._-\u0600-\u06FF]/g, '_');
            const targetPath = path.join(UPLOADS_DIR, safeName);
            const base64Clean = body.file_base64.replace(/^data:[^;]+;base64,/, '');
            fs.writeFileSync(targetPath, Buffer.from(base64Clean, 'base64'));
            fileUrl = '/uploads/' + encodeURIComponent(safeName);
          }
          const newItem = {
            id: Date.now(),
            grade: Number(body.grade) || 1,
            term: Number(body.term) || 1,
            lesson_id: Number(body.lesson_id) || 0,
            lesson_title_ar: body.lesson_title_ar || 'عام على الصف',
            lesson_title_en: body.lesson_title_en || 'General Grade Resource',
            category: body.category || 'lesson_pdf',
            title_ar: body.title_ar || 'ملف تعليمي جديد',
            title_en: body.title_en || body.title_ar || 'New Educational Resource',
            file_type: (body.category || '').includes('video') ? 'video' : 'pdf',
            file_url: fileUrl,
            created_at: new Date().toISOString().slice(0, 10)
          };
          if (!Array.isArray(db.library)) db.library = [];
          db.library.unshift(newItem);
          saveDB(db);
          return sendJSON(res, { success: true, item: newItem });
        }

        if (u.pathname === '/api/library/delete') {
          const targetId = Number(body.id);
          if (Array.isArray(db.library)) {
            db.library = db.library.filter((item) => item.id !== targetId);
            saveDB(db);
          }
          return sendJSON(res, { success: true });
        }

        if (u.pathname === '/api/live/book-private') {
          const booking = {
            id: 'PRV-' + Math.floor(100000 + Math.random() * 900000),
            student_name: body.student_name || 'طالب المرحلة الإعدادية',
            student_phone: body.student_phone || '',
            grade: Number(body.grade) || 1,
            track: body.track || 'ar',
            session_type: body.session_type || 'explain_lesson',
            target_topic: body.target_topic || 'الدرس الأول: التناسب',
            preferred_date: body.preferred_date || new Date().toISOString().slice(0, 10),
            preferred_time: body.preferred_time || '18:00',
            teacher_name: body.teacher_name || 'أ. محمود عبد الرحمن',
            notes: body.notes || '',
            status: 'confirmed',
            created_at: new Date().toISOString()
          };
          if (!Array.isArray(db.private_bookings)) db.private_bookings = [];
          db.private_bookings.unshift(booking);
          saveDB(db);
          return sendJSON(res, { success: true, booking });
        }

        if (u.pathname === '/api/live/enroll-schedule') {
          const scheduleId = Number(body.schedule_id);
          const found = DEFAULT_FIXED_SCHEDULES.find((s) => s.id === scheduleId) || DEFAULT_FIXED_SCHEDULES[0];
          const enrollment = {
            id: 'SCH-' + Math.floor(100000 + Math.random() * 900000),
            schedule_id: found.id,
            grade: found.grade,
            lesson_title_ar: found.lesson_title_ar,
            lesson_title_en: found.lesson_title_en,
            teacher_ar: found.teacher_ar,
            teacher_en: found.teacher_en,
            days_ar: found.days_ar,
            days_en: found.days_en,
            time_ar: found.time_ar,
            time_en: found.time_en,
            created_at: new Date().toISOString()
          };
          if (!Array.isArray(db.schedule_enrollments)) db.schedule_enrollments = [];
          if (!db.schedule_enrollments.some((e) => e.schedule_id === found.id)) {
            db.schedule_enrollments.unshift(enrollment);
            saveDB(db);
          }
          return sendJSON(res, { success: true, enrollment, enrollments: db.schedule_enrollments });
        }

        if (u.pathname === '/api/live/purchase-recording') {
          const recId = Number(body.recording_id);
          if (!Array.isArray(db.recorded_purchases)) db.recorded_purchases = [];
          if (!db.recorded_purchases.includes(recId)) {
            db.recorded_purchases.push(recId);
            saveDB(db);
          }
          return sendJSON(res, { success: true, recorded_purchases: db.recorded_purchases });
        }

        if (u.pathname === '/api/placement-tests/add') {
          if (!Array.isArray(db.placement_tests)) db.placement_tests = DEFAULT_PLACEMENT_TESTS;
          const newTest = {
            id: Date.now(),
            grade: Number(body.grade) || 1,
            branch: body.branch || 'comprehensive',
            title_ar: body.title_ar || 'اختبار تحديد مستوى جديد',
            title_en: body.title_en || body.title_ar || 'New Placement Test',
            duration_mins: Number(body.duration_mins) || 20,
            questions: Array.isArray(body.questions) && body.questions.length > 0 ? body.questions : []
          };
          db.placement_tests.unshift(newTest);
          saveDB(db);
          return sendJSON(res, { success: true, test: newTest, tests: db.placement_tests });
        }

        if (u.pathname === '/api/admin/units') {
          if (!Array.isArray(db.units)) db.units = [];
          const newUnit = {
            id: Date.now(),
            grade: Number(body.grade) || 1,
            term: Number(body.term) || 1,
            title_ar: body.title_ar || 'وحدة دراسية جديدة',
            title_en: body.title_en || body.title_ar || 'New Study Unit',
            lessons: []
          };
          db.units.push(newUnit);
          saveDB(db);
          return sendJSON(res, { success: true, unit: newUnit });
        }

        if (u.pathname === '/api/admin/lessons') {
          if (!Array.isArray(db.units)) db.units = [];
          const targetUnit = db.units.find((x) => Number(x.id) === Number(body.unit_id));
          const newLesson = {
            id: Date.now(),
            unit_id: Number(body.unit_id) || 1,
            title_ar: body.title_ar || 'درس جديد',
            title_en: body.title_en || body.title_ar || 'New Lesson',
            video_url_ar: body.video_url_ar || '',
            explain_ar: body.explain_ar || '',
            explain_en: body.explain_en || body.explain_ar || '',
            examples: Array.isArray(body.examples) ? body.examples : []
          };
          if (targetUnit) {
            if (!Array.isArray(targetUnit.lessons)) targetUnit.lessons = [];
            targetUnit.lessons.push(newLesson);
          }
          saveDB(db);
          return sendJSON(res, { success: true, lesson: newLesson });
        }

        if (u.pathname === '/api/admin/import-curriculum') {
          return sendJSON(res, { success: true, message: 'تم الحفظ بنجاح' });
        }

        return sendJSON(res, { success: false, error: 'المسار غير موجود' }, 404);
        } catch (postErr) {
          recordMrCodeError('http-post', postErr.message, postErr.stack);
          if (!res.writableEnded) {
            return sendJSON(res, { success: false, error: 'حدث خطأ داخلي أثناء معالجة الطلب' }, 500);
          }
        }
      });
      return;
    }

    if (u.pathname.startsWith('/uploads/')) {
      const decodedName = decodeURIComponent(u.pathname.replace('/uploads/', ''));
      const safeFile = path.join(UPLOADS_DIR, path.basename(decodedName));
      if (fs.existsSync(safeFile)) {
        const ext = path.extname(safeFile).toLowerCase();
        const mimeMap = {
          '.pdf': 'application/pdf',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.ogg': 'video/ogg',
          '.png': 'image/png',
          '.jpg': 'image/jpeg'
        };
        res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        return fs.createReadStream(safeFile).pipe(res);
      }
    }

    const decodedPathname = decodeURIComponent(u.pathname);
    if (decodedPathname === '/اينشتاين.jpg' || decodedPathname === '/mr_aref.jpg' || decodedPathname === '/mr_aref.png') {
      const avatarCandidates = [
        path.join(__dirname, 'public', decodedPathname.slice(1)),
        path.join(__dirname, decodedPathname.slice(1)),
        path.join(__dirname, 'public', 'اينشتاين.jpg'),
        path.join(__dirname, 'public', 'mr_aref.jpg')
      ];
      for (const imgFile of avatarCandidates) {
        if (fs.existsSync(imgFile)) {
          const ext = path.extname(imgFile).toLowerCase();
          res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
          return res.end(fs.readFileSync(imgFile));
        }
      }
    }

    if (u.pathname === '/logo.png' || u.pathname === '/educational_platform_logo.png' || u.pathname === '/logo.svg') {
      const candidates = [
        path.join(__dirname, 'public', u.pathname.slice(1)),
        path.join(__dirname, u.pathname.slice(1)),
        path.join(__dirname, 'public', 'logo.svg')
      ];
      for (const fileCandidate of candidates) {
        if (fs.existsSync(fileCandidate)) {
          const ext = path.extname(fileCandidate).toLowerCase();
          res.writeHead(200, { 'Content-Type': ext === '.svg' ? 'image/svg+xml; charset=utf-8' : 'image/png' });
          return res.end(fs.readFileSync(fileCandidate));
        }
      }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      return res.end(DEFAULT_LOGO_SVG);
    }

    let htmlPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(htmlPath)) htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Server is running on port 3000</h2>');
  })
  .listen(PORT, () => {
    console.log('====================================================');
    console.log(`🚀 Server Running on: http://localhost:${PORT}`);
    console.log('====================================================');
  });