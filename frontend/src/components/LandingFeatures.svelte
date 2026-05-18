<!--
  LandingFeatures — 6 Feature-Cards für die Marketing-Section unter dem LoginModal-Hero.
  Phase 1 der Landing-Migration. Phase 2 (Particles, E2E-Demo, Tech-Terminal) später.
-->
<script>
  import { i18nStore } from '../stores/i18n.svelte.js';

  let lang = $derived(i18nStore.lang);

  let features = $derived([
    { title: lang.featurePasskeyTitle    || '🌍 Passkey-Only',         desc: lang.featurePasskeyDesc    || '', highlight: true },
    { title: lang.featureE2eTitle        || '🔒 End-to-End Encryption',desc: lang.featureE2eDesc        || '' },
    { title: lang.featureBotResistantTitle || '🤖 Bot-resistant',       desc: lang.featureBotResistantDesc || '', highlight: true },
    { title: lang.featureGuestTitle      || '🔗 Guest Access',         desc: lang.featureGuestDesc      || '' },
    { title: lang.featureCallsTitle      || '🎙️ Anrufe ohne US-Cloud', desc: lang.featureCallsDesc      || '' },
    { title: lang.featureZeroTrackTitle  || '🛡️ Zero Tracking',       desc: lang.featureZeroTrackDesc  || '' },
  ]);
</script>

<section class="landing-features">
  <h2 class="features-title">{lang.landingSectionTitle || 'Built for people who care about privacy'}</h2>
  <p class="features-sub">{lang.landingSectionSub || 'The first messenger with passkey-only login. No phone number. No email. No password. Just you.'}</p>

  <div class="features-grid">
    {#each features as f, i (i)}
      <div class="feature-card" class:highlight={f.highlight}>
        <h3>{f.title}</h3>
        <p>{f.desc}</p>
      </div>
    {/each}
  </div>
</section>

<style>
  .landing-features {
    width: 100%;
    max-width: 1080px;
    margin: 64px auto 0;
    padding: 0 24px;
  }

  .features-title {
    font-size: 24px;
    font-weight: 800;
    color: var(--text-primary);
    text-align: center;
    line-height: 1.25;
    margin: 0 0 12px;
  }

  .features-sub {
    font-size: 14px;
    color: var(--text-secondary);
    text-align: center;
    line-height: 1.6;
    margin: 0 auto 32px;
    max-width: 560px;
  }

  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 14px;
  }

  .feature-card {
    background: var(--bg-panel);
    border: 1px solid var(--border-subtle);
    border-radius: 14px;
    padding: 20px;
    transition: border-color 0.18s, transform 0.12s, box-shadow 0.18s;
  }

  .feature-card:hover {
    border-color: var(--accent-voice);
    transform: translateY(-2px);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
  }

  .feature-card.highlight {
    border-color: var(--accent-voice);
    background: linear-gradient(180deg, var(--bg-panel) 0%, rgba(56, 189, 248, 0.06) 100%);
  }

  .feature-card h3 {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 8px;
    line-height: 1.3;
  }

  .feature-card p {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0;
  }

  @media (max-width: 480px) {
    .landing-features {
      margin-top: 48px;
      padding: 0 16px;
    }
    .features-title { font-size: 20px; }
    .features-sub   { font-size: 13px; margin-bottom: 24px; }
  }
</style>
