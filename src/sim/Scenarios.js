/**
 * Flight-simulator scenarios. Each one picks a world (route), a starting
 * situation and the weather, and optionally a LESSON: an instructor that
 * talks the pilot through a procedure step by step.
 *
 *   start: 'runway'  lined up on the runway, engine idling, parking brake set
 *          'final'   on a 3° approach `distance` metres from the threshold
 *          'air'     cruising at `altitude` metres, `speed` m/s
 *   wind:  { from (deg), speed (m/s), gust (m/s), turbulence (m/s rms) }
 *   lesson: 'circuit' | 'approach' | 'canyon' | null
 */
export const SCENARIOS = [
  {
    id: 'circuit',
    route: 'airfield',
    name: 'First Solo: Takeoff & Circuit',
    place: 'Valley Airfield · RWY 35',
    blurb: 'Take off, fly a full traffic pattern and land again. An instructor talks you through every leg.',
    start: 'runway',
    flaps: 1 / 3,
    wind: { from: 340, speed: 3, gust: 1.5, turbulence: 0.5 },
    lesson: 'circuit',
    preview: 'linear-gradient(180deg, #3d7cc8 0%, #bcd6ee 48%, #6f8a4e 56%, #3f5a2a 70%, #2b2b2e 71%, #2b2b2e 74%, #4a6a32 75%)',
    tag: 'LESSON',
  },
  {
    id: 'approach',
    route: 'airfield',
    name: 'Final Approach',
    place: 'Valley Airfield · RWY 35',
    blurb: 'One and a half miles out on a 3° glide path, gear down, flaps 20. Fly the PAPI and the glide-slope needles to a smooth touchdown.',
    start: 'final',
    distance: 2800,
    flaps: 2 / 3,
    wind: { from: 330, speed: 4, gust: 2, turbulence: 0.8 },
    lesson: 'approach',
    preview: 'linear-gradient(180deg, #4b86cc 0%, #c8dcef 55%, #58743c 62%, #2e2e31 66%, #2e2e31 70%, #58743c 72%)',
    tag: 'LESSON',
  },
  {
    id: 'crosswind',
    route: 'airfield',
    name: 'Gusty Crosswind Landing',
    place: 'Valley Airfield · RWY 35',
    blurb: 'A 15-knot wind from the right, gusting 24. Crab on final, then kick it straight and drop the upwind wing for the touchdown.',
    start: 'final',
    distance: 2600,
    flaps: 2 / 3,
    wind: { from: 50, speed: 7.5, gust: 4.5, turbulence: 1.6 },
    lesson: 'approach',
    preview: 'linear-gradient(160deg, #5a6f86 0%, #aab8c6 50%, #4f6a3a 60%, #2e2e31 64%, #2e2e31 68%, #4f6a3a 70%)',
    tag: 'CHALLENGE',
  },
  {
    id: 'canyon',
    route: 'canyon',
    name: 'Canyon Run & Landing',
    place: 'Red Rock Canyon · RWY 36',
    blurb: 'Follow the winding canyon down to the desert, then lose height and land on the strip beyond its mouth.',
    start: 'air',
    altitude: 320,
    speed: 52,
    wind: { from: 10, speed: 4, gust: 3, turbulence: 1.4 },
    lesson: 'canyon',
    preview: 'linear-gradient(180deg, #7fb6e6 0%, #e8c9a0 45%, #b5532e 60%, #6e2e1a 100%)',
    tag: 'CHALLENGE',
  },
  {
    id: 'desert',
    route: 'canyon',
    name: 'Desert Departure',
    place: 'Red Rock Canyon · RWY 36',
    blurb: 'Hot midday air, a short strip and mesas ahead. Take off and explore; come back and land when you are ready.',
    start: 'runway',
    flaps: 1 / 3,
    wind: { from: 20, speed: 3, gust: 2, turbulence: 1.0 },
    lesson: null,
    preview: 'linear-gradient(180deg, #6fa6dc 0%, #e8d2a8 50%, #c9874a 58%, #2f2f31 63%, #2f2f31 67%, #c9874a 69%)',
  },
  {
    id: 'sunset',
    route: 'sunset',
    name: 'Coastal Sunset Cruise',
    place: 'Lighthouse Coast',
    blurb: 'A calm evening flight over the islands toward the low sun. No airfield here: just fly.',
    start: 'air',
    altitude: 260,
    speed: 55,
    wind: { from: 250, speed: 4, gust: 1, turbulence: 0.4 },
    lesson: null,
    preview: 'linear-gradient(180deg, #26305e 0%, #b8607a 40%, #f2925a 58%, #ffcf8a 62%, #1a2a48 100%)',
  },
  {
    id: 'aurora',
    route: 'aurora',
    name: 'Night Flight under the Aurora',
    place: 'Frozen Lake',
    blurb: 'Fly on instruments by moonlight while the northern lights dance overhead.',
    start: 'air',
    altitude: 420,
    speed: 55,
    wind: { from: 300, speed: 5, gust: 2, turbulence: 0.6 },
    lesson: null,
    preview: 'radial-gradient(ellipse at 50% 120%, #dfe8f5 0%, #0c2a4a 35%, transparent 60%), linear-gradient(180deg, #050a1f 0%, #0d3b4a 35%, #2affb0 48%, #1b2f6a 62%, #0c2a4a 100%)',
  },
];

/** Weather presets selectable on the scenario screen (null = the scenario's own). */
export const WEATHER = [
  { id: 'default', label: 'Scenario weather', wind: null },
  { id: 'calm', label: 'Calm', wind: { from: 0, speed: 0, gust: 0, turbulence: 0 } },
  { id: 'breezy', label: 'Breezy', wind: { from: 300, speed: 6, gust: 3, turbulence: 1.0 } },
  { id: 'rough', label: 'Rough air', wind: { from: 240, speed: 9, gust: 6, turbulence: 2.4 } },
];
