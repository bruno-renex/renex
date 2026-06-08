<!--
  LandingFooter — Legal-Links + Copyright unter der Marketing-Section.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);
  let manifestoUrl = $derived(i18nStore.currentLang === 'de' ? '/manifest-de/' : '/manifesto/');
</script>

<footer class="landing-footer">
  <nav class="footer-links">
    <a href={manifestoUrl} target="_blank" rel="noopener">{lang.manifestoLabel || 'Manifesto'}</a>
    <a href="/press/" target="_blank" rel="noopener">{lang.footerPress || 'Press'}</a>
    <a href="/impressum/" target="_blank" rel="noopener">{lang.footerImprint || 'Impressum'}</a>
    <a href="/datenschutz/" target="_blank" rel="noopener">{lang.footerPrivacy || 'Datenschutz'}</a>
    <a href="/agb/" target="_blank" rel="noopener">{lang.footerTerms || 'AGB'}</a>
    <a href="/feedback/" target="_blank" rel="noopener">{lang.footerFeedback || 'Feedback'}</a>
    <a href="https://github.com/bruno-renex/renex" target="_blank" rel="noopener">GitHub</a>
  </nav>
  <div class="footer-copy">{lang.landingFooterCopy || '© 2026 RENEX'}</div>
</footer>

<style>
  .landing-footer {
    width: 100%;
    max-width: 1080px;
    margin: 64px auto 0;
    padding: 32px 24px 32px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .footer-links {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 18px;
  }

  .footer-links a {
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 0.15s;
  }
  .footer-links a:hover {
    color: var(--accent-voice);
    text-decoration: underline;
  }

  .footer-copy {
    font-size: 11px;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  @media (max-width: 480px) {
    .landing-footer {
      margin-top: 48px;
      padding: 24px 16px;
    }
    .footer-links { gap: 14px; }
  }
</style>
