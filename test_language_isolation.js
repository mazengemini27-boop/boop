/**
 * =========================================================================
 * 🧪 اختبار الفصل اللغوي التام (Strict Tri-Lingual Isolation Test Suite)
 * =========================================================================
 * طريقة التشغيل:
 *   1) احفظ هذا الملف باسم test_language_isolation.js داخل مجلد math-platform
 *   2) افتح شاشة الأوامر (CMD) داخل نفس المجلد واكتب:
 *      node test_language_isolation.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const HTML_PATH = path.join(__dirname, 'public', 'index.html');
const SERVER_PATH = path.join(__dirname, 'server.js');

const HAS_ARABIC = /[\u0600-\u06FF]/;
const HAS_LATIN = /[a-zA-Z]/;
const HAS_LATEX_LEAK = /[\$\\*#^{}]/;

// قراءة ملف الواجهة واستخراج كود السكربت للفحص في بيئة معزولة
const htmlContent = fs.readFileSync(HTML_PATH, 'utf8');
const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/);
const frontScript = scriptMatch ? scriptMatch[1] : '';

function extractFromFrontScript() {
  const sandbox = {
    currentLang: 'ar',
    window: {
      speechSynthesis: {
        getVoices: () => [
          { name: 'Microsoft David - English (United States)', lang: 'en-US' },
          { name: 'Google français', lang: 'fr-FR' },
          { name: 'Microsoft Hamed - Arabic (Egypt)', lang: 'ar-EG' }
        ]
      }
    }
  };

  const uiMatch = frontScript.match(/const UI_I18N = \{[\s\S]*?\n    \};/);
  const catalogMatch = frontScript.match(/const ALL_LESSONS_CATALOG = \[[\s\S]*?\n    \];/);
  const cleanMatch = frontScript.match(/function cleanSpokenArabic\([\s\S]*?\n    \}/);
  const voicePickerMatch = frontScript.match(/function pickBestVoiceForLang\([\s\S]*?\n    \}/);

  const snippet = [
    uiMatch ? uiMatch[0] : 'const UI_I18N = {};',
    catalogMatch ? catalogMatch[0] : 'const ALL_LESSONS_CATALOG = [];',
    cleanMatch ? cleanMatch[0] : 'function cleanSpokenArabic(t){ return t; }',
    voicePickerMatch ? voicePickerMatch[0] : 'function pickBestVoiceForLang(){ return null; }',
    '({ UI_I18N, ALL_LESSONS_CATALOG, cleanSpokenArabic, pickBestVoiceForLang })'
  ].join('\n\n');

  return vm.runInNewContext(snippet, sandbox);
}

function auditSpokenText(text, lang) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, reason: 'النص المنطوق فارغ' };
  if (HAS_LATEX_LEAK.test(s)) {
    return { ok: false, reason: `تسرب رموز LaTeX/Markdown داخل النطق: ${s.match(HAS_LATEX_LEAK)[0]}` };
  }
  if (lang === 'ar') {
    if (HAS_LATIN.test(s)) {
      return { ok: false, reason: `تسرب حروف لاتينية داخل النطق العربي: "${s.match(/[a-zA-Z]+/g)?.slice(0, 3).join(', ')}"` };
    }
    return { ok: true, reason: 'نطق عربي خالص 100%' };
  }
  if (lang === 'en') {
    if (HAS_ARABIC.test(s)) return { ok: false, reason: 'تسرب حروف عربية داخل النطق الإنجليزي' };
    if (/\b(égale|multiplié par|au carré|centimètres|théorème)\b/i.test(s)) {
      return { ok: false, reason: 'تسرب كلمات فرنسية داخل النطق الإنجليزي' };
    }
    return { ok: true, reason: 'نطق إنجليزي خالص 100%' };
  }
  if (lang === 'fr') {
    if (HAS_ARABIC.test(s)) return { ok: false, reason: 'تسرب حروف عربية داخل النطق الفرنسي' };
    if (/\b(equals|multiplied by|squared|centimeters|product of extremes|square root)\b/i.test(s)) {
      return { ok: false, reason: 'تسرب كلمات إنجليزية داخل النطق الفرنسي' };
    }
    return { ok: true, reason: 'نطق فرنسي خالص 100%' };
  }
  return { ok: false, reason: 'لغة غير معروفة' };
}

async function runTriLingualIsolationSuite() {
  console.log('=========================================================================');
  console.log('🌐 بدء الاختبار الصارم للفصل التام بين اللغات الثلاث (النصوص + أصوات مستر عارف)');
  console.log('=========================================================================\n');

  const results = [];
  const extracted = extractFromFrontScript();

  // 1. فحص قاموس الواجهة (UI_I18N)
  try {
    const { UI_I18N } = extracted;
    const arKeys = Object.keys(UI_I18N.ar || {});
    const enLeaks = Object.entries(UI_I18N.en || {}).filter(([, v]) => HAS_ARABIC.test(String(v)));
    const frLeaks = Object.entries(UI_I18N.fr || {}).filter(([, v]) => HAS_ARABIC.test(String(v)));
    const missingEn = arKeys.filter((k) => !(k in (UI_I18N.en || {})));
    const missingFr = arKeys.filter((k) => !(k in (UI_I18N.fr || {})));
    const dirsOk = UI_I18N.ar?.dir === 'rtl' && UI_I18N.en?.dir === 'ltr' && UI_I18N.fr?.dir === 'ltr';

    results.push({
      name: '١. فصل قاموس الواجهة والأزرار (UI_I18N — AR / EN / FR)',
      passed: enLeaks.length === 0 && frLeaks.length === 0 && missingEn.length === 0 && missingFr.length === 0 && dirsOk,
      metric: `عدد المفاتيح: ${arKeys.length} | تسرب عربي في EN: ${enLeaks.length} | تسرب عربي في FR: ${frLeaks.length} | اتجاه الصفحات (RTL/LTR): ${dirsOk ? '✅' : '❌'}`
    });
  } catch (e) {
    results.push({ name: '١. فصل قاموس الواجهة والأزرار (UI_I18N)', passed: false, metric: e.message });
  }

  // 2. فحص فهرس المنهج والدروس والمعادلات
  try {
    const { ALL_LESSONS_CATALOG } = extracted;
    const enCatalogLeaks = ALL_LESSONS_CATALOG.filter(
      (l) => HAS_ARABIC.test(l.title?.en || '') || HAS_ARABIC.test(l.unit?.en || '') || HAS_ARABIC.test(l.formula?.en || '')
    );
    const frCatalogLeaks = ALL_LESSONS_CATALOG.filter(
      (l) => HAS_ARABIC.test(l.title?.fr || '') || HAS_ARABIC.test(l.unit?.fr || '') || HAS_ARABIC.test(l.formula?.fr || '')
    );
    results.push({
      name: '٢. فصل نصوص ومعادلات فهرس المنهج (ALL_LESSONS_CATALOG)',
      passed: ALL_LESSONS_CATALOG.length >= 15 && enCatalogLeaks.length === 0 && frCatalogLeaks.length === 0,
      metric: `إجمالي الدروس: ${ALL_LESSONS_CATALOG.length} | تسرب في EN: ${enCatalogLeaks.length} | تسرب في FR: ${frCatalogLeaks.length}`
    });
  } catch (e) {
    results.push({ name: '٢. فصل نصوص ومعادلات فهرس المنهج', passed: false, metric: e.message });
  }

  // 3. فحص دالة تنقية النطق الأمامية (cleanSpokenArabic)
  try {
    const { cleanSpokenArabic } = extracted;
    const sampleMath = '$$\\frac{x}{6} = \\frac{4}{8} \\implies x^2 = 9 \\text{ (10 cm)}$$';
    const outAr = cleanSpokenArabic('إذا كان $\\frac{4}{8} = \\frac{1}{2}$ فإن الناتج 10', 'ar');
    const outEn = cleanSpokenArabic(`مرحباً ${sampleMath}`, 'en');
    const outFr = cleanSpokenArabic(`أهلاً ${sampleMath}`, 'fr');

    const auditAr = auditSpokenText(outAr, 'ar');
    const auditEn = auditSpokenText(outEn, 'en');
    const auditFr = auditSpokenText(outFr, 'fr');

    const enHasTerms = outEn.includes('over') && outEn.includes('squared') && outEn.includes('centimeters');
    const frHasTerms = outFr.includes('sur') && outFr.includes('au carré') && outFr.includes('centimètres');

    results.push({
      name: '٣. فحص محرك تحويل المعادلات للنطق بالواجهة (cleanSpokenArabic AR/EN/FR)',
      passed: auditAr.ok && auditEn.ok && auditFr.ok && enHasTerms && frHasTerms,
      metric: `AR (${auditAr.ok ? '✅' : auditAr.reason}) | EN (${auditEn.ok && enHasTerms ? '✅' : auditEn.reason}) | FR (${auditFr.ok && frHasTerms ? '✅' : auditFr.reason})`
    });
  } catch (e) {
    results.push({ name: '٣. فحص محرك تحويل المعادلات للنطق بالواجهة', passed: false, metric: e.message });
  }

  // 4. فحص اختيار الصوت الصحيح لكل لغة (pickBestVoiceForLang)
  try {
    const { pickBestVoiceForLang } = extracted;
    const vAr = pickBestVoiceForLang('ar');
    const vEn = pickBestVoiceForLang('en');
    const vFr = pickBestVoiceForLang('fr');
    const voicesIsolated =
      String(vAr?.lang || '').toLowerCase().startsWith('ar') &&
      String(vEn?.lang || '').toLowerCase().startsWith('en') &&
      String(vFr?.lang || '').toLowerCase().startsWith('fr');

    results.push({
      name: '٤. فحص عزل اختيار أصوات المتصفح (pickBestVoiceForLang)',
      passed: voicesIsolated,
      metric: `AR -> ${vAr?.name || 'none'} | EN -> ${vEn?.name || 'none'} | FR -> ${vFr?.name || 'none'}`
    });
  } catch (e) {
    results.push({ name: '٤. فحص عزل اختيار أصوات المتصفح', passed: false, metric: e.message });
  }

  // تشغيل خادم Node.js الحي للاختبارات 5 إلى 10
  const TEST_PORT = 3098;
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: 'pipe'
  });

  await new Promise((resolve) => setTimeout(resolve, 900));
  const baseUrl = `http://localhost:${TEST_PORT}`;

  try {
    // 5. فحص الشعار المتجهي لكل لغة (/logo.svg)
    const [logoAr, logoEn, logoFr] = await Promise.all([
      fetch(`${baseUrl}/logo.svg?lang=ar`).then((r) => r.text()),
      fetch(`${baseUrl}/logo.svg?lang=en`).then((r) => r.text()),
      fetch(`${baseUrl}/logo.svg?lang=fr`).then((r) => r.text())
    ]);
    const arLogoOk = HAS_ARABIC.test(logoAr) && !/Egyptian Ministry|Ministère Égyptien/i.test(logoAr);
    const enLogoOk = !HAS_ARABIC.test(logoEn) && logoEn.includes('Egyptian Ministry of Knowledge') && !logoEn.includes('Ministère');
    const frLogoOk = !HAS_ARABIC.test(logoFr) && logoFr.includes('Ministère Égyptien du Savoir') && !logoFr.includes('Egyptian Ministry');

    results.push({
      name: '٥. فصل لغة الشعار الرسمي المتجهي (/logo.svg?lang=ar|en|fr)',
      passed: arLogoOk && enLogoOk && frLogoOk,
      metric: `AR: ${arLogoOk ? '✅' : '❌'} | EN: ${enLogoOk ? '✅' : '❌'} | FR: ${frLogoOk ? '✅' : '❌'}`
    });

    // 6. فحص شروحات مستر عارف النصية باللغات الثلاث
    const [tutAr, tutEn, tutFr] = await Promise.all([
      fetch(`${baseUrl}/api/ai/tutor`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'اشرحلي نظرية فيثاغورس', track: 'ar' })
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/ai/tutor`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Explain Pythagoras theorem', track: 'en' })
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/ai/tutor`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Expliquer le théorème de Pythagore', track: 'fr' })
      }).then((r) => r.json())
    ]);

    const arTextPure = tutAr.effective_lang === 'ar' && HAS_ARABIC.test(tutAr.answer || '') && !/Pythagoras Theorem|Théorème de Pythagore/i.test(tutAr.answer || '');
    const enTextPure = tutEn.effective_lang === 'en' && !HAS_ARABIC.test(JSON.stringify({ a: tutEn.answer, p: tutEn.pre_study, q: tutEn.practice_question })) && !/Théorème|Produit en croix/i.test(tutEn.answer || '');
    const frTextPure = tutFr.effective_lang === 'fr' && !HAS_ARABIC.test(JSON.stringify({ a: tutFr.answer, p: tutFr.pre_study, q: tutFr.practice_question })) && !/Product of Extremes|Welcome to/i.test(tutFr.answer || '');

    results.push({
      name: '٦. فصل نصوص شرح مستر عارف وبطاقة المذاكرة والتمارين (/api/ai/tutor)',
      passed: arTextPure && enTextPure && frTextPure,
      metric: `AR (${arTextPure ? '✅' : '❌'}) | EN (${enTextPure ? '✅' : '❌'}) | FR (${frTextPure ? '✅' : '❌'})`
    });

    // 7. فحص الرسوم الهندسية التوضيحية (SVG Diagrams)
    const svgArPure = HAS_ARABIC.test(tutAr.diagram_svg || '') && !/Pythagoras Theorem|Théorème/i.test(tutAr.diagram_svg || '');
    const svgEnPure = !HAS_ARABIC.test(tutEn.diagram_svg || '') && (tutEn.diagram_svg || '').includes('Pythagoras Theorem');
    const svgFrPure = !HAS_ARABIC.test(tutFr.diagram_svg || '') && (tutFr.diagram_svg || '').includes('Théorème de Pythagore');

    results.push({
      name: '٧. فصل لغة الرسوم الهندسية التوضيحية (SVG Diagrams)',
      passed: svgArPure && svgEnPure && svgFrPure,
      metric: `رسم عربي خالص (${svgArPure ? '✅' : '❌'}) | رسم إنجليزي خالص (${svgEnPure ? '✅' : '❌'}) | رسم فرنسي خالص (${svgFrPure ? '✅' : '❌'})`
    });

    // 8. فحص نقاء أصوات ونصوص نطق مستر عارف (Spoken Audio Text)
    const spAr = auditSpokenText(tutAr.spoken_summary, 'ar');
    const spEn = auditSpokenText(tutEn.spoken_summary, 'en');
    const spFr = auditSpokenText(tutFr.spoken_summary, 'fr');

    const stepsArOk = (tutAr.video_steps || []).every((st) => auditSpokenText(st.narration, 'ar').ok);
    const stepsEnOk = (tutEn.video_steps || []).every((st) => auditSpokenText(st.narration, 'en').ok);
    const stepsFrOk = (tutFr.video_steps || []).every((st) => auditSpokenText(st.narration, 'fr').ok);

    results.push({
      name: '٨. فصل ونقاء نصوص النطق الصوتي لمستر عارف في جميع الخطوات (spoken_summary + video_steps)',
      passed: spAr.ok && spEn.ok && spFr.ok && stepsArOk && stepsEnOk && stepsFrOk,
      metric: `AR: ${spAr.ok && stepsArOk ? '✅' : spAr.reason} | EN: ${spEn.ok && stepsEnOk ? '✅' : spEn.reason} | FR: ${spFr.ok && stepsFrOk ? '✅' : spFr.reason}`
    });

    // 9. فحص مسار الصوت الحي في الخادم (/api/tts) للغات الثلاث
    const [ttsAr, ttsEn, ttsFr] = await Promise.all([
      fetch(`${baseUrl}/api/tts?lang=ar&text=${encodeURIComponent('أهلاً بك يا بطل في درس التناسب')}`),
      fetch(`${baseUrl}/api/tts?lang=en&text=${encodeURIComponent('Welcome champion to the proportion lesson')}`),
      fetch(`${baseUrl}/api/tts?lang=fr&text=${encodeURIComponent('Bienvenue champion dans la leçon des proportions')}`)
    ]);

    const ttsStatusValid = (r) => r.status === 200 || r.status === 204;
    const [bufAr, bufEn, bufFr] = await Promise.all([
      ttsAr.status === 200 ? ttsAr.arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
      ttsEn.status === 200 ? ttsEn.arrayBuffer() : Promise.resolve(new ArrayBuffer(0)),
      ttsFr.status === 200 ? ttsFr.arrayBuffer() : Promise.resolve(new ArrayBuffer(0))
    ]);

    const audioMode = (r, buf) => (r.status === 200 ? `صوت خادم حي (${buf.byteLength} بايت ${r.headers.get('content-type')})` : 'احتياطي متصفح (204)');

    results.push({
      name: '٩. فحص مسار التوليد الصوتي لمستر عارف (/api/tts) باللغات الثلاث',
      passed: ttsStatusValid(ttsAr) && ttsStatusValid(ttsEn) && ttsStatusValid(ttsFr),
      metric: `AR: ${audioMode(ttsAr, bufAr)} | EN: ${audioMode(ttsEn, bufEn)} | FR: ${audioMode(ttsFr, bufFr)}`
    });

    // 10. فحص الفصل اللغوي في مكتبة المحتوى الذكي والمساعد الصوتي
    const [voiceEn, voiceFr, searchFr] = await Promise.all([
      fetch(`${baseUrl}/api/smart-library/voice-assistant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: 'Explain proportion', lang: 'en' })
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/smart-library/voice-assistant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: 'Expliquer les proportions', lang: 'fr' })
      }).then((r) => r.json()),
      fetch(`${baseUrl}/api/smart-library/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Pythagore', lang: 'fr' })
      }).then((r) => r.json())
    ]);

    const voiceEnPure = auditSpokenText(voiceEn.spoken_reply, 'en').ok && !HAS_ARABIC.test(voiceEn.reply || '');
    const voiceFrPure = auditSpokenText(voiceFr.spoken_reply, 'fr').ok && !HAS_ARABIC.test(voiceFr.reply || '');
    const searchFrPure = (searchFr.results || []).length > 0 && (searchFr.results || []).every((r) => !HAS_ARABIC.test((r.title || '') + (r.snippet || '')));

    results.push({
      name: '١٠. فصل اللغات في المساعد الصوتي والبحث الذكي (/api/smart-library/*)',
      passed: voiceEnPure && voiceFrPure && searchFrPure,
      metric: `المساعد الصوتي EN (${voiceEnPure ? '✅' : '❌'}) | المساعد الصوتي FR (${voiceFrPure ? '✅' : '❌'}) | البحث الذكي FR (${searchFrPure ? '✅' : '❌'})`
    });
  } catch (err) {
    results.push({
      name: '❌ خطأ أثناء الاتصال بالخادم الحي للاختبار',
      passed: false,
      metric: err.message
    });
  } finally {
    child.kill();
  }

  let passedCount = 0;
  results.forEach((r) => {
    if (r.passed) passedCount++;
    console.log(`${r.passed ? '✅ [PASS]' : '❌ [FAIL]'} ${r.name}`);
    console.log(`   📊 التفاصيل: ${r.metric}\n`);
  });

  const score = Math.round((passedCount / results.length) * 100);
  console.log('=========================================================================');
  console.log(`🏆 نتيجة اختبار الفصل اللغوي التام: نجح ${passedCount} من ${results.length} اختبارات بنسبة ${score}%`);
  console.log('=========================================================================');
  process.exit(passedCount === results.length ? 0 : 1);
}

runTriLingualIsolationSuite();