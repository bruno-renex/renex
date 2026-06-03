<!--
  LandingManifesto — Call-out-Section, die zum öffentlichen Manifest verlinkt.
  Steht in LoginModal zwischen LandingFeatures und LandingFooter.
  Sprach-abhängige URL: DE → /manifest-de/, sonst → /manifesto/ (nur EN+DE existieren).
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);
  let manifestoUrl = $derived(i18nStore.currentLang === 'de' ? '/manifest-de/' : '/manifesto/');
</script>

<section class="landing-manifesto">
  <div class="manifesto-card">
    <h2 class="manifesto-title">{lang.landingManifestoTitle || 'Why RENEX exists'}</h2>
    <p class="manifesto-body">{lang.landingManifestoBody || ''}</p>
    <a class="manifesto-cta" href={manifestoUrl} target="_blank" rel="noopener">
      {lang.landingManifestoCta || 'Read the Manifesto →'}
    </a>
  </div>
</section>

<style>
  .landing-manifesto {
    width: 100%;
    max-width: 1080px;
    margin: 64px auto 0;
    padding: 0 24px;
  }

  .manifesto-card {
    background: linear-gradient(135deg, rgba(56, 189, 248, 0.08), rgba(56, 189, 248, 0.02));
    border: 1px solid var(--accent-voice);
    border-radius: 18px;
    padding: 40px 32px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
  }

  .manifesto-title {
    font-size: 24px;
    font-weight: 800;
    color: var(--text-primary);
    line-height: 1.25;
    margin: 0;
  }

  .manifesto-body {
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.7;
    margin: 0 auto;
    max-width: 620px;
  }

  .manifesto-cta {
    margin-top: 8px;
    padding: 12px 24px;
    background: var(--accent-voice);
    color: #07070a;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
    letter-spacing: 0.02em;
    transition: background 0.15s, transform 0.1s;
  }

  .manifesto-cta:hover {
    background: #0ea5e9;
  }

  .manifesto-cta:active {
    transform: scale(0.98);
  }

  @media (max-width: 480px) {
    .landing-manifesto {
      margin-top: 48px;
      padding: 0 16px;
    }
    .manifesto-card { padding: 28px 20px; }
    .manifesto-title { font-size: 20px; }
    .manifesto-body  { font-size: 13px; }
  }
</style>
