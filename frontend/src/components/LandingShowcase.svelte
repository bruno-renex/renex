<!--
  LandingShowcase — zeigt ein echtes App-Screenshot direkt nach dem Hero.
  Beantwortet die wichtigste Frage eines Erstbesuchers: "Wie sieht das aus?"

  Bild liegt in frontend/public/app-preview-pulse.png — echter 1:1-Chat mit
  aktivem Pulse (✨ an, cyan Partikel im Hintergrund). Quelle: assets/.
  Voller Screenshot (Standalone-PWA inkl. Composer) — kein Crop nötig.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);
</script>

<section class="landing-showcase">
  <h2 class="showcase-title">{lang.showcaseTitle || 'So sieht RENEX aus'}</h2>
  <p class="showcase-sub">{lang.showcaseSub || 'Klar, ruhig, ohne Ablenkung. Deine Kontakte und Chats an einem Ort.'}</p>

  <div class="phone-frame">
    <img
      src="/app-preview-pulse.png"
      alt={lang.showcaseAlt || 'RENEX App — Kontakte- und Chat-Übersicht'}
      loading="lazy"
      decoding="async"
      width="1179"
      height="2556"
    />
  </div>
</section>

<style>
  .landing-showcase {
    width: 100%;
    max-width: 1080px;
    margin: 64px auto 0;
    padding: 0 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .showcase-title {
    font-size: 24px;
    font-weight: 800;
    color: var(--text-primary);
    line-height: 1.25;
    margin: 0 0 12px;
  }

  .showcase-sub {
    font-size: 14px;
    color: var(--text-secondary);
    line-height: 1.6;
    margin: 0 auto 32px;
    max-width: 520px;
  }

  /* Phone-Bezel um den Screenshot. aspect-ratio = native Bild-Ratio → voller
     Ausschnitt ohne Verzerrung/Crop (Standalone-PWA, kein Browser-Chrome). */
  .phone-frame {
    width: 100%;
    max-width: 280px;
    aspect-ratio: 1179 / 2556;
    overflow: hidden;
    border-radius: 30px;
    border: 6px solid #16161c;
    background: #000;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--border-subtle);
  }

  .phone-frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
    display: block;
  }

  @media (max-width: 480px) {
    .landing-showcase {
      margin-top: 48px;
      padding: 0 16px;
    }
    .showcase-title { font-size: 20px; }
    .showcase-sub   { font-size: 13px; margin-bottom: 24px; }
    .phone-frame    { max-width: 240px; }
  }
</style>
