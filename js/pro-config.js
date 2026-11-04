/* js/pro-config.js — Pro feature list + free limits + prices (Step 3) */
const ProConfig = (() => {
  const PRICES = { monthly: 6.49, yearly: 64.99 };
  const MONTHLY_COUNT = 12;
  const yearlySaved = +(MONTHLY_COUNT * PRICES.monthly - PRICES.yearly).toFixed(2);
  const yearlyPct = Math.round((yearlySaved / (MONTHLY_COUNT * PRICES.monthly)) * 100);
  const FEATURES = [
    { key: 'music_library', title: 'Unlimited Music Library', desc: 'Dive into our complete, restriction-free music library.' },
    { key: 'insights', title: 'Extensive Focus Data and Insights', desc: 'Track your productivity with advanced focus data.' },
    { key: 'focus_fingerprint', title: 'Focus Fingerprint', desc: 'Discover your unique, personalized concentration style.' },
    { key: 'themes', title: 'Exclusive Themes and Customizability', desc: 'Fully customize your workspace with exclusive designs.' }
  ];
  const FREE = {
    musicTracks: 5,
    freeThemes: ['ember'],
    insightCards: [],
    notes: [
      'Music: 5 free tracks across genres (Lo-Fi, Jazz, Ambient, Piano, Nature).',
      'Themes: Ember only. Every other theme — light or dark — is Focus Pro.',
      'Insights: the Insights tab, its cards and the Focus Fingerprint are Focus Pro.',
      'Reports: the Breakdown tab is Focus Pro.',
      'Unlimited music, all themes, Insights, the Fingerprint and Breakdown require Focus Pro.'
    ],
    freeLimitsText: [
      'Music: 5 tracks free. The full library is Focus Pro.',
      'Insights & Breakdown: Focus Pro.',
      'Focus Fingerprint: Focus Pro.',
      'Themes: Ember is free. All other themes are Focus Pro.'
    ]
  };
  return { FEATURES, FREE, PRICES: { ...PRICES, yearlySaved, yearlyPct } };
})();
