// ─────────────────────────────────────────────────────────────
//  RENEX Manifesto — HTML page template (Direction B "Statement")
//
//  Parametrized template shared by the EN (/manifesto) and DE
//  (/manifest-de) builds. Critical CSS + particle JS are inlined
//  so the page ships as a single self-contained HTML file with
//  zero render-blocking external requests (Lighthouse + <100kb
//  page-weight target). Fonts use the system-ui stack — the site
//  CSP is `font-src 'self'`, so no web-font CDN is available and a
//  self-hosted Inter file would blow the weight budget; system-ui
//  bold/black renders the brand triple cleanly on every platform.
//
//  Consumed by scripts/build-manifesto.js.
// ─────────────────────────────────────────────────────────────

const REPO = 'https://github.com/bruno-renex/renex';

const STRINGS = {
  en: {
    htmlLang: 'en',
    docTitle: 'The RENEX Manifesto — Passkey-Only Privacy Messenger',
    description:
      'The RENEX Manifesto: a passkey-only, human-first, open-standard messenger built as a counter-movement to the AI-generated internet. No bots, no email, no ads.',
    heroCaption: 'The RENEX Manifesto',
    sectionsLabel: 'Sections',
    skipToContent: 'Skip to content',
    scrollLabel: 'Scroll to read',
    ogLocale: 'en_US',
    ogLocaleAlt: 'de_CH',
    canonical: 'https://renex.id/manifesto',
    altUrl: 'https://renex.id/manifest-de',
    ogImage: 'https://renex.id/og/og-manifesto-en.png',
    footerTagline: 'Made in Switzerland. Made for humans. Made to last.',
    footerLinks: [
      { label: 'Contributing', href: REPO + '/blob/main/docs/CONTRIBUTING.md' },
      { label: 'Protocol', href: REPO + '/blob/main/docs/PROTOCOL.md' },
      { label: 'Terms', href: '/terms/' },
      { label: 'Privacy', href: '/privacy/' },
      { label: 'GitHub', href: REPO },
    ],
    backHome: '← Back to renex.id',
  },
  de: {
    htmlLang: 'de',
    docTitle: 'Das RENEX-Manifest — Passkey-Only Privacy-Messenger',
    description:
      'Das RENEX-Manifest: ein Passkey-only-, Human-first-, Open-Standard-Messenger als Gegenbewegung zum KI-generierten Internet. Keine Bots, keine E-Mail, keine Werbung.',
    heroCaption: 'Das RENEX-Manifest',
    sectionsLabel: 'Abschnitte',
    skipToContent: 'Zum Inhalt springen',
    scrollLabel: 'Zum Lesen scrollen',
    ogLocale: 'de_CH',
    ogLocaleAlt: 'en_US',
    canonical: 'https://renex.id/manifest-de',
    altUrl: 'https://renex.id/manifesto',
    ogImage: 'https://renex.id/og/og-manifesto-de.png',
    footerTagline: 'Made in Switzerland. Made for humans. Made to last.',
    footerLinks: [
      { label: 'Mitwirken', href: REPO + '/blob/main/docs/CONTRIBUTING.md' },
      { label: 'Protokoll', href: REPO + '/blob/main/docs/PROTOCOL.md' },
      { label: 'AGB', href: '/agb/' },
      { label: 'Datenschutz', href: '/datenschutz/' },
      { label: 'GitHub', href: REPO },
    ],
    backHome: '← Zurück zu renex.id',
  },
};

// Brand triple — identical in both languages.
const HERO_LINES = ['PASSKEY-ONLY.', 'HUMAN-FIRST.', 'OPEN-STANDARD.'];

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07070A;--panel:#0D0D11;--panel-2:#121218;
  --text:#E6E6EB;--text-2:#9A9AA3;--muted:#71717A;
  --cyan:#38BDF8;--glow:rgba(56,189,248,0.35);
  --border:#27272A;--err:#EF4444;
  --font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}
body{
  font-family:var(--font);background:var(--bg);color:var(--text);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  line-height:1.6;overflow-x:hidden;
}
a{color:var(--cyan);text-decoration:none}
a:hover{text-decoration:underline}
.skip-link{position:absolute;left:-9999px;top:0;background:var(--cyan);color:var(--bg);
  padding:10px 16px;border-radius:0 0 8px 0;font-weight:700;z-index:200}
.skip-link:focus{left:0}

/* ── HERO ─────────────────────────────────────────────── */
.hero{
  position:relative;min-height:100vh;min-height:100dvh;
  display:flex;flex-direction:column;justify-content:center;
  padding:96px clamp(24px,6vw,96px);overflow:hidden;
  background:radial-gradient(ellipse 80% 60% at 50% 38%,rgba(56,189,248,0.08),transparent 70%);
}
.hero-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}
.hero-static{position:absolute;inset:0;z-index:0;display:none;
  background:radial-gradient(ellipse 70% 50% at 50% 40%,rgba(56,189,248,0.10),transparent 70%)}
.hero-top{position:absolute;top:clamp(20px,3vw,32px);left:0;right:0;
  display:flex;align-items:center;justify-content:space-between;
  padding:0 clamp(24px,6vw,96px);z-index:3}
.brand{font-size:clamp(22px,3vw,32px);font-weight:800;letter-spacing:0.04em;color:var(--text)}
.brand .x{color:var(--cyan)}
.lang-switch{display:flex;gap:4px;align-items:center;font-size:14px;font-weight:600}
.lang-switch a,.lang-switch span{
  display:inline-flex;align-items:center;justify-content:center;
  min-height:44px;min-width:44px;padding:0 10px;border-radius:10px;
  color:var(--text-2);transition:color .15s,background .15s}
.lang-switch a:hover{color:var(--cyan);text-decoration:none;background:rgba(56,189,248,0.08)}
.lang-switch .current{color:var(--cyan);background:rgba(56,189,248,0.12)}
.lang-switch .sep{min-width:auto;padding:0;color:var(--border)}
.hero-inner{position:relative;z-index:2;max-width:1100px;margin:0 auto;width:100%}
.hero h1{font-weight:800;letter-spacing:-0.02em;line-height:1.08;
  font-size:clamp(48px,9vw,96px);color:var(--text);margin:0}
.hero h1 span{display:block}
.hero h1 .l2{color:var(--text)}
.hero-caption{margin-top:clamp(20px,3vw,28px);font-size:clamp(18px,2.4vw,28px);
  color:var(--cyan);text-transform:uppercase;letter-spacing:0.12em;font-weight:600;
  text-shadow:0 0 24px var(--glow)}
.scroll-ind{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);
  z-index:2;color:var(--text-2);display:flex;flex-direction:column;align-items:center;
  gap:6px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;
  min-height:44px;justify-content:flex-end;text-decoration:none}
.scroll-ind:hover{color:var(--cyan);text-decoration:none}
.scroll-ind svg{width:22px;height:22px;animation:bob 2s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}
@media (prefers-reduced-motion: reduce){
  .hero-canvas{display:none}.hero-static{display:block}
  .scroll-ind svg{animation:none}
}

/* ── LAYOUT ───────────────────────────────────────────── */
.content{max-width:1224px;margin:0 auto;padding:clamp(64px,8vw,120px) clamp(16px,4vw,32px);
  display:grid;grid-template-columns:1fr;gap:48px}
.toc{display:none}
main{max-width:720px;width:100%;min-width:0}

/* ── SECTIONS ─────────────────────────────────────────── */
section.ms{margin-bottom:clamp(64px,9vw,120px);scroll-margin-top:24px}
section.ms:last-child{margin-bottom:0}
section.ms h2{font-size:clamp(32px,5vw,48px);font-weight:800;letter-spacing:-0.015em;
  line-height:1.12;margin-bottom:28px;color:var(--text)}
section.ms h3{font-size:clamp(20px,2.6vw,24px);font-weight:700;margin:36px 0 14px;color:var(--text)}
main p{font-size:18px;line-height:1.65;color:var(--text);margin:0 0 20px}
main ul,main ol{margin:0 0 20px;padding-left:22px}
main li{font-size:18px;line-height:1.6;color:var(--text);margin-bottom:10px}
main li::marker{color:var(--cyan)}
main strong{color:var(--text);font-weight:700}
main hr{display:none}
.meta-line{font-size:14px;color:var(--muted);margin-bottom:48px;
  padding-bottom:24px;border-bottom:1px solid var(--border)}
.meta-line a{color:var(--text-2)}
main p.label{color:var(--cyan);font-weight:700;font-size:16px;
  margin:32px 0 10px}
main p.label strong{color:var(--cyan)}

/* ── PULL-QUOTES ──────────────────────────────────────── */
.pullquote{border-left:3px solid var(--cyan);padding:6px 0 6px 24px;margin:32px 0;
  font-size:1.5em;line-height:1.4;font-style:italic;color:var(--text);font-weight:600}
.pullquote strong{color:var(--cyan);font-weight:700}
@media (min-width:1024px){.pullquote{margin-left:-32px}}
blockquote.note{border-left:3px solid var(--border);padding:4px 0 4px 20px;
  margin:28px 0;color:var(--text-2);font-style:italic}
blockquote.note p{margin:0 0 10px;font-size:16px;line-height:1.6;color:var(--text-2)}
blockquote.note p:last-child{margin-bottom:0}
.faq-intro blockquote.note{margin:8px 0 0}

/* ── PRINCIPLES GRID (full-bleed on wide screens) ─────── */
.breakout{margin-top:8px}
.principles-grid{display:grid;gap:20px;grid-template-columns:1fr}
.principle-card{background:var(--panel);border:1px solid var(--border);
  border-radius:16px;padding:24px}
.principle-card h3{margin:0 0 12px;color:var(--cyan);font-size:20px;line-height:1.25}
.principle-card p{font-size:15px;line-height:1.55;color:var(--text-2);margin:0 0 12px}
.principle-card p:last-child{margin-bottom:0}
.principle-card ul{margin:0;padding-left:18px}
.principle-card li{font-size:14px;line-height:1.5;color:var(--text-2);margin-bottom:6px}
.principle-card .pullquote{margin:0 0 12px;font-size:1.05em;padding:4px 0 4px 14px;line-height:1.4}
@media (min-width:768px){.principles-grid{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1280px){
  .breakout{position:relative;left:50%;transform:translateX(-50%);
    width:min(1080px,calc(100vw - 48px))}
  .principles-grid{grid-template-columns:repeat(5,1fr);gap:16px}
  .principle-card{padding:20px}
  .principle-card h3{font-size:17px}
}

/* ── TABLES (responsive → stacked cards on mobile) ────── */
.table-wrap{margin:24px 0}
table{width:100%;border-collapse:collapse;font-size:16px}
thead th{text-align:left;color:var(--cyan);font-weight:700;padding:12px 16px;
  border-bottom:2px solid var(--border);font-size:14px;text-transform:uppercase;letter-spacing:0.04em}
tbody td{padding:14px 16px;border-bottom:1px solid var(--border);
  color:var(--text);vertical-align:top;line-height:1.5}
tbody tr:hover{background:rgba(56,189,248,0.03)}
@media (max-width:767px){
  table,thead,tbody,tr,td{display:block;width:100%}
  thead{position:absolute;left:-9999px}
  tbody tr{background:var(--panel);border:1px solid var(--border);
    border-radius:12px;padding:8px 14px;margin-bottom:14px}
  tbody td{border-bottom:1px solid var(--border);padding:10px 0;display:flex;
    flex-direction:column;gap:4px}
  tbody td:last-child{border-bottom:none}
  tbody td::before{content:attr(data-label);font-size:12px;text-transform:uppercase;
    letter-spacing:0.05em;color:var(--cyan);font-weight:700}
}

/* ── FAQ ACCORDION ────────────────────────────────────── */
.faq-intro{margin-bottom:28px}
details.faq{border:1px solid var(--border);border-radius:12px;margin-bottom:12px;
  background:var(--panel);overflow:hidden}
details.faq[open]{border-color:rgba(56,189,248,0.3)}
details.faq summary{cursor:pointer;list-style:none;padding:18px 22px;
  font-size:17px;font-weight:600;color:var(--text);display:flex;
  align-items:flex-start;gap:12px;transition:color .15s}
details.faq summary::-webkit-details-marker{display:none}
details.faq summary:hover{color:var(--cyan)}
details.faq summary::before{content:"+";color:var(--cyan);font-weight:700;
  font-size:22px;line-height:1;flex:0 0 auto;transition:transform .2s}
details.faq[open] summary::before{content:"−"}
.faq-body{padding:0 22px 20px 50px}
.faq-body p{font-size:16px;color:var(--text-2);margin:0 0 14px}
.faq-body ul,.faq-body ol{padding-left:20px;margin:0 0 14px}
.faq-body li{font-size:16px;color:var(--text-2);margin-bottom:8px}
.faq-body strong{color:var(--text)}

/* ── FOOTER ───────────────────────────────────────────── */
.ms-footer{border-top:1px solid var(--border);padding:64px 24px 80px;text-align:center}
.ms-footer .tagline{font-size:clamp(18px,3vw,24px);font-weight:700;color:var(--text);
  text-shadow:0 0 30px var(--glow);margin-bottom:24px}
.ms-footer .links{display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:center;
  margin-bottom:24px}
.ms-footer .links a{color:var(--text-2);font-size:15px}
.ms-footer .links a:hover{color:var(--cyan)}
.ms-footer .back{font-size:14px;color:var(--muted)}

/* ── DESKTOP SIDEBAR TOC ──────────────────────────────── */
@media (min-width:1024px){
  .content{grid-template-columns:240px minmax(0,720px);gap:64px;justify-content:center;align-items:start}
  .toc{display:block;position:sticky;top:32px;align-self:start}
  .toc-title{font-size:12px;text-transform:uppercase;letter-spacing:0.1em;
    color:var(--muted);margin-bottom:16px;font-weight:700}
  .toc ol{list-style:none;border-left:1px solid var(--border);padding:0}
  .toc li{margin:0}
  .toc a{display:block;padding:7px 0 7px 16px;margin-left:-1px;font-size:14px;
    line-height:1.4;color:var(--text-2);border-left:2px solid transparent}
  .toc a:hover{color:var(--text);text-decoration:none}
  .toc a.active{color:var(--cyan);border-left-color:var(--cyan);font-weight:600}
}

/* ── MOBILE FAB + BOTTOM-SHEET ────────────────────────── */
.fab{position:fixed;bottom:20px;right:20px;z-index:60;
  display:inline-flex;align-items:center;gap:8px;
  min-height:48px;padding:0 20px;border:none;border-radius:999px;
  background:var(--cyan);color:var(--bg);font-family:var(--font);
  font-size:15px;font-weight:700;cursor:pointer;
  box-shadow:0 6px 24px rgba(56,189,248,0.4)}
.sheet-backdrop{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,0.6);
  opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s}
.sheet-backdrop.open{opacity:1;visibility:visible}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:80;
  background:var(--panel);border-top:1px solid var(--border);
  border-radius:18px 18px 0 0;padding:12px 20px max(20px,env(safe-area-inset-bottom));
  transform:translateY(100%);transition:transform .25s ease;max-height:70vh;overflow-y:auto}
.sheet.open{transform:translateY(0)}
.sheet-grip{width:40px;height:4px;border-radius:2px;background:var(--border);
  margin:6px auto 14px}
.sheet h3{font-size:13px;text-transform:uppercase;letter-spacing:0.1em;
  color:var(--muted);margin-bottom:8px}
.sheet ol{list-style:none}
.sheet a{display:block;padding:13px 8px;color:var(--text);font-size:16px;
  border-bottom:1px solid var(--border);min-height:44px}
.sheet a:hover{color:var(--cyan);text-decoration:none}
.sheet li:last-child a{border-bottom:none}
@media (min-width:1024px){.fab,.sheet,.sheet-backdrop{display:none}}
@media (prefers-reduced-motion: reduce){.sheet,.sheet-backdrop{transition:none}}
`;

// Inline UI + particle JS. Written with string concatenation (no
// template-literal interpolation) so it nests cleanly inside the
// outer template literal of renderPage(). Ported from
// frontend/src/components/LandingParticles.svelte to vanilla JS,
// plus battery-aware pause and document.hidden pause.
const SCRIPT = `
(function(){
  "use strict";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── Bottom-sheet (mobile section nav) ── */
  var fab = document.getElementById("fab");
  var sheet = document.getElementById("sheet");
  var backdrop = document.getElementById("sheet-backdrop");
  function openSheet(){ if(sheet){sheet.classList.add("open");backdrop.classList.add("open");} }
  function closeSheet(){ if(sheet){sheet.classList.remove("open");backdrop.classList.remove("open");} }
  if(fab){ fab.addEventListener("click", openSheet); }
  if(backdrop){ backdrop.addEventListener("click", closeSheet); }
  if(sheet){ sheet.addEventListener("click", function(e){ if(e.target.tagName==="A") closeSheet(); }); }

  /* ── Active TOC highlight (desktop) ── */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if(tocLinks.length && "IntersectionObserver" in window){
    var byId = {};
    tocLinks.forEach(function(a){ byId[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        var link = byId[en.target.id];
        if(!link) return;
        if(en.isIntersecting){
          tocLinks.forEach(function(l){ l.classList.remove("active"); });
          link.classList.add("active");
        }
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    document.querySelectorAll("section.ms[id]").forEach(function(s){ io.observe(s); });
  }

  /* ── Particle background ── */
  var canvas = document.getElementById("hero-canvas");
  if(!canvas || reduce) return;
  var ctx = canvas.getContext("2d");
  if(!ctx) return;
  var particles = [], raf = null, running = false, dim = null;
  var paused = { hidden:false, battery:false };

  function resize(){
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    dim = { dpr:dpr, w:rect.width, h:rect.height };
  }
  function seed(){
    var isMobile = window.matchMedia("(max-width: 767px)").matches;
    var count = isMobile ? 18 : 32;
    particles = [];
    for(var i=0;i<count;i++){
      particles.push({
        x: Math.random()*dim.w, y: Math.random()*dim.h,
        vx: (Math.random()-0.5)*0.22, vy: (Math.random()-0.5)*0.22
      });
    }
  }
  function step(){
    var w=dim.w, h=dim.h, dpr=dim.dpr;
    ctx.clearRect(0,0,w*dpr,h*dpr);
    ctx.save();
    ctx.scale(dpr,dpr);
    var MAX=130;
    for(var i=0;i<particles.length;i++){
      for(var j=i+1;j<particles.length;j++){
        var a=particles[i], b=particles[j];
        var dx=a.x-b.x, dy=a.y-b.y;
        var dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<MAX){
          var alpha=(1-dist/MAX)*0.15;
          ctx.strokeStyle="rgba(56,189,248,"+alpha+")";
          ctx.lineWidth=1;
          ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
        }
      }
    }
    ctx.fillStyle="rgba(56,189,248,0.5)";
    for(var k=0;k<particles.length;k++){
      var p=particles[k];
      ctx.beginPath();ctx.arc(p.x,p.y,1.4,0,Math.PI*2);ctx.fill();
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0||p.x>w) p.vx=-p.vx;
      if(p.y<0||p.y>h) p.vy=-p.vy;
    }
    ctx.restore();
  }
  function loop(){ if(!running) return; step(); raf=requestAnimationFrame(loop); }
  function start(){ if(running||paused.hidden||paused.battery) return; running=true; loop(); }
  function stop(){ running=false; if(raf){cancelAnimationFrame(raf);raf=null;} }

  resize(); seed(); start();

  document.addEventListener("visibilitychange", function(){
    paused.hidden = document.hidden;
    if(document.hidden) stop(); else start();
  });
  var rt;
  window.addEventListener("resize", function(){
    clearTimeout(rt);
    rt=setTimeout(function(){
      resize();
      for(var i=0;i<particles.length;i++){
        if(particles[i].x>dim.w) particles[i].x=dim.w;
        if(particles[i].y>dim.h) particles[i].y=dim.h;
      }
    },150);
  });

  /* ── Battery-aware pause (< 20% and not charging) ── */
  if(navigator.getBattery){
    navigator.getBattery().then(function(bat){
      function check(){
        paused.battery = (bat.level < 0.2 && !bat.charging);
        if(paused.battery) stop(); else start();
      }
      bat.addEventListener("levelchange", check);
      bat.addEventListener("chargingchange", check);
      check();
    }).catch(function(){});
  }
})();
`;

function jsonLd(s, dateModified) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: s.heroCaption,
    description: s.description,
    inLanguage: s.htmlLang,
    datePublished: '2026-06-02',
    dateModified: dateModified,
    author: { '@type': 'Person', name: 'Bruno Hochstrasser' },
    publisher: {
      '@type': 'Organization',
      name: 'RENEX',
      url: 'https://renex.id',
    },
    image: s.ogImage,
    mainEntityOfPage: { '@type': 'WebPage', '@id': s.canonical },
    license: 'https://creativecommons.org/licenses/by/4.0/',
  });
}

function langSwitch(lang) {
  // EN button + DE button, current one marked.
  const en =
    lang === 'en'
      ? '<span class="current">🇬🇧 EN</span>'
      : '<a href="/manifesto" hreflang="en">🇬🇧 EN</a>';
  const de =
    lang === 'de'
      ? '<span class="current">🇨🇭 DE</span>'
      : '<a href="/manifest-de" hreflang="de">🇨🇭 DE</a>';
  return (
    '<nav class="lang-switch" aria-label="Language">' +
    de +
    '<span class="sep">/</span>' +
    en +
    '</nav>'
  );
}

function tocList(toc) {
  return toc
    .map((t) => '<li><a href="#' + t.id + '">' + t.title + '</a></li>')
    .join('');
}

const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/**
 * Render a full standalone manifesto HTML page.
 * @param {object} opts
 * @param {'en'|'de'} opts.lang
 * @param {string} opts.contentHtml  rendered <main> inner HTML
 * @param {Array<{id,title}>} opts.toc
 * @param {string} opts.dateModified  ISO date string
 */
export function renderPage({ lang, contentHtml, toc, dateModified }) {
  const s = STRINGS[lang];
  const heroH1 =
    '<h1>' +
    HERO_LINES.map(
      (line, i) => '<span class="l' + (i + 1) + '">' + line + '</span>'
    ).join('') +
    '</h1>';

  return `<!DOCTYPE html>
<html lang="${s.htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#07070A">
<title>${s.docTitle}</title>
<meta name="description" content="${s.description}">
<meta name="robots" content="index, follow">
<meta name="author" content="Bruno Hochstrasser">
<link rel="canonical" href="${s.canonical}">
<link rel="alternate" hreflang="en" href="https://renex.id/manifesto">
<link rel="alternate" hreflang="de" href="https://renex.id/manifest-de">
<link rel="alternate" hreflang="x-default" href="https://renex.id/manifesto">
<meta property="og:title" content="${s.docTitle}">
<meta property="og:description" content="${s.description}">
<meta property="og:image" content="${s.ogImage}">
<meta property="og:url" content="${s.canonical}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="RENEX">
<meta property="og:locale" content="${s.ogLocale}">
<meta property="og:locale:alternate" content="${s.ogLocaleAlt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="@renex_app">
<meta name="twitter:title" content="${s.docTitle}">
<meta name="twitter:description" content="${s.description}">
<meta name="twitter:image" content="${s.ogImage}">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<script type="application/ld+json">${jsonLd(s, dateModified)}</script>
<style>${CSS}</style>
</head>
<body>
<a class="skip-link" href="#content">${s.skipToContent}</a>

<header class="hero">
  <canvas id="hero-canvas" class="hero-canvas" aria-hidden="true"></canvas>
  <div class="hero-static" aria-hidden="true"></div>
  <div class="hero-top">
    <a class="brand" href="/" aria-label="RENEX home">RENE<span class="x">X</span></a>
    ${langSwitch(lang)}
  </div>
  <div class="hero-inner">
    ${heroH1}
    <p class="hero-caption">${s.heroCaption}</p>
  </div>
  <a class="scroll-ind" href="#content" aria-label="${s.scrollLabel}">
    <span>${s.scrollLabel}</span>${CHEVRON}
  </a>
</header>

<div class="content">
  <aside class="toc" aria-label="${s.sectionsLabel}">
    <div class="toc-title">${s.sectionsLabel}</div>
    <ol>${tocList(toc)}</ol>
  </aside>
  <main id="content">
${contentHtml}
  </main>
</div>

<footer class="ms-footer">
  <div class="tagline">${s.footerTagline}</div>
  <nav class="links" aria-label="Footer">
    ${s.footerLinks
      .map((l) => '<a href="' + l.href + '">' + l.label + '</a>')
      .join('')}
  </nav>
  <div class="back"><a href="/">${s.backHome}</a></div>
</footer>

<button class="fab" id="fab" aria-label="${s.sectionsLabel}">📑 ${s.sectionsLabel}</button>
<div class="sheet-backdrop" id="sheet-backdrop"></div>
<nav class="sheet" id="sheet" aria-label="${s.sectionsLabel}">
  <div class="sheet-grip"></div>
  <h3>${s.sectionsLabel}</h3>
  <ol>${tocList(toc)}</ol>
</nav>

<script>${SCRIPT}</script>
</body>
</html>
`;
}
