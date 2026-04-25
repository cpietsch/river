// Quick smoke test for universality. Run via:
//   npx tsx src/graph/extractSpans.test.ts
// Not part of the build — just dev verification.

import { extractSpans } from './extractSpans';

const samples = [
  {
    topic: 'tech',
    text: `For most developers, the MacBook Pro M-series hits the best balance of performance, battery life, and Unix-based terminal experience. If you prefer Windows or Linux, the ThinkPad X1 Carbon is a longtime favorite for its keyboard and repairability. Your budget and whether you need a dedicated GPU for machine learning will narrow things down fast. Pi-KVM running on a Raspberry Pi Zero 2 W is a well-established option, though TinyPilot offers a polished commercial alternative.`,
  },
  {
    topic: 'cooking',
    text: `For a tender pot roast, sear the chuck on all sides in a hot Dutch oven before adding aromatics. Deglaze with red wine, then add 2 cups of beef stock, a sprig of thyme, and a bay leaf. Cover and braise at 325°F for about 3 hours, until the meat shreds easily with a fork. Serve over mashed potatoes with the pan juices reduced into a glossy gravy.`,
  },
  {
    topic: 'history',
    text: `The Renaissance began in 14th-century Florence under the patronage of the Medici family. Figures like Leonardo da Vinci and Michelangelo Buonarroti redefined the relationship between art and science, drawing on rediscovered classical texts. By the time of the High Renaissance, the Vatican had become a major commissioner of works, including the Sistine Chapel ceiling and Raphael's School of Athens. The movement spread north through trade routes to Flanders and the Holy Roman Empire.`,
  },
  {
    topic: 'philosophy',
    text: `Immanuel Kant argued that moral worth depends on duty rather than consequence — what he called the categorical imperative. Acting out of inclination, even when the outcome is good, lacks the same moral weight as acting from a rational principle one could universalize. Critics like Bernard Williams pointed out that this framework can produce alienation: it severs the agent from the projects and relationships that give life meaning.`,
  },
  {
    topic: 'biology',
    text: `Mitochondria generate ATP through oxidative phosphorylation, a process tightly coupled to the electron transport chain in the inner membrane. Disruption of the proton gradient — by uncouplers like 2,4-dinitrophenol — collapses ATP synthesis even when oxygen and substrate are abundant. Defects in mitochondrial DNA, inherited maternally, underlie disorders such as Leber's hereditary optic neuropathy and MELAS syndrome.`,
  },
];

for (const s of samples) {
  const spans = extractSpans(s.text);
  console.log(`\n=== ${s.topic} (${spans.length} spans) ===`);
  for (const span of spans) {
    console.log(`  - ${span.phrase}`);
  }
}
