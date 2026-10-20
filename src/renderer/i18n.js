'use strict';
/**
 * i18n — four locales like the reference: tr (default), en, zh-CN, ar.
 * Flat key → string tables; t(key, params) interpolates {name} placeholders.
 * RTL locales (ar) get document.dir set at apply-time.
 */
const LOCALES = {
  tr: {
    'app.title': 'OzyComp',
    'nav.office': 'Ofis',
    'nav.tasks': 'Görevler',
    'nav.board': 'Pano',
    'nav.settings': 'Ayarlar',
    'spawn.title': 'Yeni ajan',
    'spawn.id': 'Ajan kimliği',
    'spawn.provider': 'Sağlayıcı',
    'spawn.model': 'Model (opsiyonel)',
    'spawn.go': 'Başlat',
    'desk.send': 'Gönder',
    'desk.steer': 'Yönlendir',
    'desk.kill': 'Sonlandır',
    'tasks.todo': 'Yapılacak',
    'tasks.doing': 'Sürüyor',
    'tasks.blocked': 'Tıkalı',
    'tasks.done': 'Bitti',
    'settings.temps': 'Geçici işçiler kendi kendine işe alım yapabilir',
    'settings.lang': 'Dil',
    'status.offline': 'çevrimdışı',
    'status.running': 'çalışıyor',
    'prompt.question': 'Ajan soruyor',
  },
  en: {
    'app.title': 'OzyComp',
    'nav.office': 'Office',
    'nav.tasks': 'Tasks',
    'nav.board': 'Board',
    'nav.settings': 'Settings',
    'spawn.title': 'New agent',
    'spawn.id': 'Agent id',
    'spawn.provider': 'Provider',
    'spawn.model': 'Model (optional)',
    'spawn.go': 'Spawn',
    'desk.send': 'Send',
    'desk.steer': 'Steer',
    'desk.kill': 'Kill',
    'tasks.todo': 'To do',
    'tasks.doing': 'Doing',
    'tasks.blocked': 'Blocked',
    'tasks.done': 'Done',
    'settings.temps': 'Temps may self-hire',
    'settings.lang': 'Language',
    'status.offline': 'offline',
    'status.running': 'running',
    'prompt.question': 'Agent asks',
  },
  'zh-CN': {
    'app.title': 'OzyComp',
    'nav.office': '办公室',
    'nav.tasks': '任务',
    'nav.board': '看板',
    'nav.settings': '设置',
    'spawn.title': '新代理',
    'spawn.id': '代理 ID',
    'spawn.provider': '提供方',
    'spawn.model': '模型（可选）',
    'spawn.go': '启动',
    'desk.send': '发送',
    'desk.steer': '引导',
    'desk.kill': '终止',
    'tasks.todo': '待办',
    'tasks.doing': '进行中',
    'tasks.blocked': '受阻',
    'tasks.done': '完成',
    'settings.temps': '允许临时工自主招聘',
    'settings.lang': '语言',
    'status.offline': '离线',
    'status.running': '运行中',
    'prompt.question': '代理提问',
  },
  ar: {
    'app.title': 'OzyComp',
    'nav.office': 'المكتب',
    'nav.tasks': 'المهام',
    'nav.board': 'اللوحة',
    'nav.settings': 'الإعدادات',
    'spawn.title': 'وكيل جديد',
    'spawn.id': 'معرّف الوكيل',
    'spawn.provider': 'المزوّد',
    'spawn.model': 'النموذج (اختياري)',
    'spawn.go': 'تشغيل',
    'desk.send': 'إرسال',
    'desk.steer': 'توجيه',
    'desk.kill': 'إنهاء',
    'tasks.todo': 'قيد الانتظار',
    'tasks.doing': 'جارٍ',
    'tasks.blocked': 'محظور',
    'tasks.done': 'منجز',
    'settings.temps': 'يمكن للوكلاء المؤقتين التوظيف ذاتيًا',
    'settings.lang': 'اللغة',
    'status.offline': 'غير متصل',
    'status.running': 'يعمل',
    'prompt.question': 'الوكيل يسأل',
  },
};

const RTL = new Set(['ar']);
let locale = 'tr';

function t(key, params = {}) {
  let s = LOCALES[locale]?.[key] ?? LOCALES.tr[key] ?? key;
  for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
function setLocale(l) {
  if (!LOCALES[l]) return;
  locale = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.documentElement.dir = RTL.has(l) ? 'rtl' : 'ltr';
  }
}
function getLocale() { return locale; }

if (typeof module !== 'undefined') module.exports = { LOCALES, t, setLocale, getLocale };
