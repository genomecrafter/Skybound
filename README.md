# Skybound — A Scenic Flight Experience

Skybound is a curated, arcade-style scenic flight. You fly a small propeller aircraft through three hand-crafted routes, each built around one visual "moment":

| Route | Moment | Highlights |
|---|---|---|
| **Aurora Flyover** | Northern lights flare above a frozen lake | Raymarched aurora shader, star field, GPU snowfall, moonlight shadows, cabin village lights |
| **Sunset Ocean Skim** | Racing the low sun across the waves | Gerstner-wave ocean with noise ripples, sky reflections and whitecaps, layered sunset clouds, palm islands, lighthouse spotlight, sea stacks, seabirds |
| **Canyon Landing** | Threading the narrows, then landing | Terraced canyon terrain, airstrip with edge lights + PAPI, full landing logic |
| *Free Flight Valley* | *(sandbox)* | Alpine valley, 7600 instanced spruces (two levels of detail), clouds, airfield (runway 35) |

There is also a **Flight Simulator** mode (title screen → *Flight Simulator*): the same worlds flown with a realistic aircraft model, a working instrument panel and lessons with an instructor. See [Flight Simulator mode](#flight-simulator-mode).

Everything is generated **in code**: no 3D models, no image textures and no audio files. Geometry is built from three.js primitives and custom `BufferGeometry`, textures are painted on `<canvas>` or computed in shaders, and all sound is synthesised with the Web Audio API.

---

## Running it

Requirements: **Node.js 20.19+ or 22.12+** and a recent Chrome or Edge.

```bash
cd skybound
npm install
npm run dev        # opens http://localhost:5173
```

Production build: `npm run build`, then `npm run preview`.

**Performance:** the game measures its own frame rate and adjusts the render resolution to hold about 60 FPS. The top-right corner shows `FPS · res%`. On slow laptops choose **Graphics: Low** on the title screen (or open `?quality=low`). This turns off post-processing and reduces clouds, trees and aurora steps.

## Controls

| Input | Action |
|---|---|
| **↑ / ↓** (W / S) | Climb / dive |
| **← / →** (A / D) | Bank and turn (a little rudder is added automatically) |
| **Q / E** | Rudder (fine yaw) |
| **Mouse wheel** (Shift / Ctrl) | Throttle up / down |
| **Mouse move** | Look around (eases back behind the plane) |
| **Hold left click** | Boost (energy bar on the HUD) |
| **Right click** / **G** | Landing gear up / down (animated) |
| **C** | Toggle chase / cockpit camera |
| **T** | Transform Debug panel + axes helper |
| **M** | Mute / unmute |
| **Esc** | Pause menu (Resume · Restart · Choose route · Main menu) |

**How to play:** fly through the glowing rings in order. The **gold** ring is the next one; an arrow on the screen edge points to it when it's off-screen. Crashing returns you to the last ring passed. On the **Canyon** route, finish by landing:
1. Lower the gear.
2. Fly through the approach-gate ring.
3. Throttle back and keep the PAPI lights at 2 white + 2 red (the HUD also shows *ON SLOPE*).
4. Flare gently just before touchdown.
5. Pull the throttle to idle to brake.

A touchdown is accepted with the gear down, a sink rate under 4 m/s, wings within 12° of level and the nose not pointing down.

---

## Flight Simulator mode

Pick **Flight Simulator** on the title screen, choose the weather, the start view and the auto-rudder assist, then a scenario:

| Scenario | Start | What you practise |
|---|---|---|
| **First Solo: Takeoff & Circuit** (lesson) | Valley Airfield, on runway 35 | Take-off, climb, the four legs of a traffic pattern, approach and landing, with an instructor guiding every step |
| **Final Approach** (lesson) | 1.5 NM out on the 3° glide path | Flying the PAPI and the ILS needles, flare and touchdown |
| **Gusty Crosswind Landing** | Same, 15 kt wind from the right, gusting 24 | Crabbing, de-crabbing, wing-low touchdown |
| **Canyon Run & Landing** | Above the red-rock canyon | Following terrain, losing height, landing on a short strip |
| **Desert Departure** | Canyon airstrip, on runway 36 | Free flight from a hot desert strip |
| **Coastal Sunset Cruise**, **Night Flight under the Aurora** | In the air | Free flight (no airfield) |

**Flight controls (simulator)**

| Input | Action |
|---|---|
| **↑ ↓ ← →** (W A S D) | Elevator and ailerons (keys build up deflection gradually and centre when released) |
| **Q / E** | Rudder and nose-wheel steering |
| **Mouse wheel** (Shift / Ctrl) | Throttle |
| **F / V** | Flaps down / up (0, 10, 20, 30°) |
| **[ / ]** | Elevator trim nose down / up |
| **Space** (B) | Wheel brakes (hold) · **P** parking brake |
| **G** | Landing gear (locked while the weight is on the wheels) |
| **Y** | Mouse yoke on/off: the mouse moves the control column (middle click centres it) |
| **H** | Instrument panel overlay · **C** cockpit / chase view |
| **Gamepad** | Left stick = ailerons + elevator, right stick = rudder, RT/LT = throttle, A/B = flaps, X = brakes, Y = gear, D-pad = trim |

**Cockpit and HUD:** the 3D panel carries the classic six-pack (airspeed, attitude, altimeter, turn coordinator, heading, vertical speed) plus RPM, g-meter, warning lights, flaps/trim/throttle indicators and a GS/TAS/wind readout. All of it is live. The HUD adds a data strip, a north-up moving map with the traffic pattern and your track, ILS-style approach needles, and warnings (stall horn, overspeed, sink rate, gear, parking brake).

**Debrief:** after you stop on the runway, the landing is graded out of 100 on sink rate, centre-line deviation, touchdown point and speed. Crashes (prop strike, wing tip, gear-up landing, gear collapse from a hard or sideways touchdown, over-stress) end the flight with the reason.

**Typical numbers:** liftoff at about 55 kt, best climb about 75 kt (around 850 ft/min), cruise about 110 kt, stall 53 kt clean and 45 kt with full flaps, approach 65 kt.

---

## Project structure

```
src/
  main.js                 renderer + game loop (requestAnimationFrame)
  config.js               all tuning constants (flight, camera, quality, bloom)
  core/    Game.js (state machine + frame update), Input.js, CameraRig.js,
           AudioEngine.js, PostFX.js, Performance.js, Landing.js, DevAutopilot.js
  aircraft/ AircraftModel.js, FlightModel.js, NavLights.js, Trails.js
  sim/     SimFlightModel.js (6-DOF flight dynamics + landing gear), Wind.js,
           Instruments.js (panel gauges), SimHUD.js, SimSession.js, Scenarios.js
  world/   Sky.js, Environment.js, Terrain.js, TerrainDetail.js, Water.js, Aurora.js,
           Stars.js, Snow.js, Clouds.js, Rings.js, Birds.js, Lighthouse.js, Runway.js,
           Foliage.js (vegetation textures, material, LOD),
           Props.js, Glow.js
  routes/  Route.js (base), AuroraRoute.js, SunsetRoute.js, CanyonRoute.js, TestRoute.js
  ui/      HUD.js, Menus.js (incl. SimSelect), Results.js, Caption.js, DebugPanel.js
  shaders/ sky, water, aurora, cloud, ring, beam, grade (.vert/.frag GLSL)
```

---

## Graphics Concepts Used

Each concept is listed with the file and function where it is implemented. The source comments explain each one in more detail.

### 1. 3D modelling (procedural geometry)
| Concept | Where |
|---|---|
| Aircraft built only from code | `aircraft/AircraftModel.js`: `buildFuselage`, `buildPropeller`, `buildWings`, `buildTail`, `buildGear` |
| **Surface of revolution** (LatheGeometry): fuselage and spinner from a spline profile | `AircraftModel.js`: `latheAlongZ()` |
| **Lofted airfoil surfaces** (custom `BufferGeometry`, NACA thickness formula): wings, tail, prop blades | `AircraftModel.js`: `airfoilPoints()`, `loftSurface()` |
| Vertex displacement (bending the tail cone, ribbed cactus cross-sections) | `AircraftModel.js`: `buildFuselage`; `world/Props.js`: `addRibbed` |
| Trees built from code: trunk tubes along curves + folded, textured branch cards (spruce whorls, arching palm fronds), all one geometry | `world/Props.js`: `buildSpruceNear`, `buildSpruceFar`, `buildPalm`, `buildCactus`, `buildShrub`; `world/Foliage.js`: `GeoBuilder` |
| Custom `BufferGeometry` (positions + index buffer) | `world/Terrain.js`: constructor; `world/Water.js`: `buildPolarGrid`; `world/Birds.js`: `makeWingGeometry`; `world/Aurora.js` |
| Editing an index buffer: cockpit opening cut out of the fuselage along the canopy footprint, dark interior tub seen from the inside (`BackSide`) | `AircraftModel.js`: `buildFuselage` |
| **Cockpit interior**: cockpit-view-only cabin shell with a superellipse cross-section (headliner, door frames, B-pillars, slim A-pillars, side and corner windows, sun visors) swapped in for the bubble's inside parts, so the chase view is unchanged; closed cabin (fuselage lining = the skin's triangles drawn `BackSide`, roof strip of the canopy ellipsoid with paint outside / headliner inside, rear wall as a triangle fan, baggage shelf), windscreen bow and canopy rails as tubes along ellipse sections of the canopy, glare shield as a parametric surface, panel as a `ShapeGeometry` with a curved top, inner canopy glass (`BackSide`, canvas tint + dust + reflections), yokes (column translation = pitch, wheel rotation = roll), throttle lever, compass card counter-rotating with the heading | `aircraft/Cockpit.js` |
| Primitive modelling (Box, Cylinder, Cone, Sphere, Torus, Circle) | `world/Lighthouse.js`, `world/Runway.js` (hangar, tower, windsock), `AuroraRoute.js`: `buildVillage` (cabins, prism roofs) |
| Procedural terrain from noise (fBm, ridged noise, terraces) | `utils/noise.js`: `createNoise` (`fbm`, `ridged`); route `build()` height functions; `routes/CanyonRoute.js`: `terrace()` |
| Exact height queries matching the rendered triangles (barycentric interpolation) | `world/Terrain.js`: `heightAt` |

### 2. Scene graph / hierarchical modelling
| Concept | Where |
|---|---|
| Aircraft hierarchy: root → wings → aileron pivots; tail → elevator / rudder hinge; propeller; gear legs | `AircraftModel.js` (diagram in the header comment) |
| Pivot groups placed on hinge lines so surfaces rotate about their hinge | `AircraftModel.js`: `buildWings` (aileronPivot), `buildTail` (rudderAxis → rudderHinge) |
| Mirroring with negative scale (left wing = right wing, `scale.x = -1`) | `AircraftModel.js`: `buildWings` |
| Lighthouse beam pivot carrying the SpotLight, its target and the beam cone | `world/Lighthouse.js`: constructor |
| Birds as small hierarchies (body + flapping wing pivots) | `world/Birds.js`: constructor |
| Runway group: lights, PAPI, windsock, buildings move as one | `world/Runway.js`: constructor |
| Route content in one Group (switching routes = remove + dispose) | `routes/Route.js`: `dispose` |

### 3. Transformations: translation, rotation, scaling
| Transformation | Where |
|---|---|
| **Translation** of the aircraft (velocity integration) | `aircraft/FlightModel.js`: `update` (`position.addScaledVector`) |
| **Translation** of the landing gear retracting / extending | `AircraftModel.js`: `update` (gear `position.y`) |
| **Rotation**: propeller spin proportional to throttle | `AircraftModel.js`: `update` |
| **Rotation**: ailerons, elevator, rudder deflect with input | `AircraftModel.js`: `update` |
| **Rotation**: aircraft pitch / roll / yaw | `FlightModel.js`: `update` (local-space quaternion multiply) |
| **Rotation**: lighthouse beam, flapping wings, windsock | `Lighthouse.js`: `update`; `Birds.js`: `update`; `Runway.js`: `update` |
| **Rotation / translation** in the simulator: flaps, spinning wheels, gear struts compressing under load | `AircraftModel.js`: `update` |
| World → local transform: the windsock points along the real wind in the runway's own frame | `Runway.js`: `update` |
| **Scaling**: rings pulse, burst when passed, smaller when far ahead | `world/Rings.js`: `update` |
| **Non-uniform scaling**: canopy bubble, bird bodies, cabin roofs, wing taper | `AircraftModel.js`: `buildFuselage`; `Birds.js`; `AuroraRoute.js`: `buildVillage`; `AircraftModel.js`: `loftSurface` |
| **Shear matrix** (wing / fin sweep, `Matrix4.makeShear`) | `AircraftModel.js`: `loftSurface` |
| Composing T·R·S instance matrices | `world/Props.js`: `makeInstanced` (`Matrix4.compose`) |
| Local ↔ world transforms (runway coordinates, cockpit eye point) | `core/Landing.js`: `local`; `core/CameraRig.js`: `updateCockpit` |
| Live Transform Debug panel (position, Euler, quaternion, scale, 4×4 matrix) + AxesHelper | `ui/DebugPanel.js`: `update`, `toggle` |

### 4. Quaternions
| Concept | Where |
|---|---|
| Aircraft orientation stored as a quaternion (no gimbal lock) | `FlightModel.js`: header comment, `update` |
| Local-space rotation `q = q · dq` vs world-space `q = dq · q` | `FlightModel.js`: `update`, `rotateWorld` |
| Shortest-arc rotation + slerp ("weathervane" stability) | `FlightModel.js`: `update` (`setFromUnitVectors`, `slerp`) |
| Euler ↔ quaternion (ground roll heading/pitch, debug display) | `FlightModel.js`: `updateGround`; `ui/DebugPanel.js` |
| Orienting rings to face the path | `world/Rings.js`: constructor (`setFromUnitVectors`) |

### 5. Lighting
| Light type | Where / purpose |
|---|---|
| **DirectionalLight**: sun or moon, colour and direction per route | `world/Environment.js`: constructor, `apply`; presets in each route's `atmosphere` |
| **HemisphereLight**: sky and ground fill (red rock bounce in the canyon, aurora-green tint) | `Environment.js`; `AuroraRoute.js`: `update` |
| **PointLight**: blinking nav lights (red left, green right, white strobe) | `aircraft/NavLights.js`: constructor, `update` |
| **PointLight**: runway threshold lights, cabin village lamp, lighthouse lamp | `world/Runway.js`; `AuroraRoute.js`: `buildVillage`; `world/Lighthouse.js` |
| **SpotLight**: rotating lighthouse beam | `world/Lighthouse.js`: constructor |
| Emissive / HDR "light" materials (runway bulbs, PAPI, windows, instruments) | `world/Runway.js`; `AuroraRoute.js`; `AircraftModel.js`: `makeInstrumentTexture` |
| **Image-based lighting**: sky captured into a PMREM environment map | `world/Environment.js`: `updateEnvMap` |
| Physically based materials (MeshStandard / MeshPhysical: roughness, metalness, clear-coat) | `AircraftModel.js` (materials); `AuroraRoute.js` (ice) |
| Inverse-square light falloff (why the nav lights are offset from the wing) | `NavLights.js`: header comment |

### 6. Shadows
| Concept | Where |
|---|---|
| Directional shadow map with an orthographic shadow camera that follows the aircraft | `world/Environment.js`: constructor, `update` |
| castShadow / receiveShadow on aircraft, terrain, props and buildings | `AircraftModel.js`; `Terrain.js`; `Props.js`: `makeInstanced`; `Runway.js` |
| Shadow bias / normalBias against shadow acne | `Environment.js`: constructor |

### 7. Shaders (custom GLSL)
| Shader | Technique | Where |
|---|---|---|
| Sky dome | Gradient sky, sun/moon disc and halo | `shaders/sky.*.glsl`, `world/Sky.js` |
| Ocean | 8 **Gerstner waves** in the vertex shader; whitecaps from the wave **Jacobian**; noise **normal-map** ripples (3 scrolling layers); Fresnel (Schlick); reflection of a sky **cube map**; normalised Blinn-Phong sun glitter with distance roughness (Toksvig); fake subsurface scattering | `shaders/water.*.glsl`, `world/Water.js`, `world/Environment.js`: `updateEnvMap` |
| Aurora | **Raymarching** through layered triangle-wave noise | `shaders/aurora.*.glsl`, `world/Aurora.js` |
| Checkpoint rings | Rim glow, moving energy bands, additive blending | `shaders/ring.*.glsl`, `world/Rings.js` |
| Lighthouse beam | Fake volumetric cone (additive, soft edges) | `shaders/beam.*.glsl`, `world/Lighthouse.js` |
| Clouds | Instanced camera-facing billboards lit as one **ellipsoid volume** per cloud: Beer-Lambert self-shadowing toward the sun, view-ray thickness for the forward-scattering "silver lining" | `shaders/cloud.*.glsl`, `world/Clouds.js` |
| Sky cloud layers | Ray-plane projection + **domain-warped fBm**, lighting from the density gradient toward the sun, motion parallax (high streaks + lower broken deck at sunset) | `shaders/sky.frag.glsl`, `world/Sky.js` |
| Vegetation | Alpha-tested **foliage cards** with alpha-to-coverage, outward "volume" normals, baked AO, translucency, mip-level alpha boost, wind sway, snow tint (`onBeforeCompile` on MeshStandardMaterial) | `world/Foliage.js`: `createFoliageMaterial` |
| Stars, snow | Point sprites; snow positions animated and wrapped (`mod`) entirely on the GPU | `world/Stars.js`, `world/Snow.js` |
| Vapour trails | Dynamic ribbon geometry with per-vertex alpha | `aircraft/Trails.js` |
| Post-processing | NaN-sanitise → **bloom** → tone mapping → lens flare, colour grade, vignette, grain | `core/PostFX.js`, `shaders/grade.frag.glsl` |

### 8. Procedural noise and textures
| Concept | Where |
|---|---|
| Simplex noise, fBm (octaves), ridged noise | `utils/noise.js` |
| Seeded random generator (repeatable worlds) | `utils/math.js`: `mulberry32` |
| Tileable noise via 4D torus mapping (terrain detail and bump maps) | `world/TerrainDetail.js`: `makeTileable` |
| Canvas-painted textures: aircraft livery, runway markings, lighthouse stripes, windsock, instruments | `AircraftModel.js`: `makeLiveryTexture`, `makeInstrumentTexture`; `Runway.js`: `makeRunwayTexture`; `Lighthouse.js`: `makeStripeTexture` |
| Procedurally painted pixel data (DataTexture): needle sprays, palm fronds, bark, scrub; cloud puffs with normals from the density gradient; ocean ripple normal map | `world/Foliage.js`: `makeConiferAtlas`, `makePalmAtlas`, `makeShrubAtlas`; `Clouds.js`: `makeCloudAtlas`; `Water.js`: `makeRippleNormalMap` |
| Vertex colours from height and slope (snow, rock, sand, strata) | `world/Terrain.js` + each route's `colorFn` |
| Multiple UV sets (detail map on `uv`, bump map on `uv1`) | `world/Terrain.js`, `TerrainDetail.js` |

### 9. Instancing and performance
| Concept | Where |
|---|---|
| `InstancedMesh`: trees, rocks, sea stacks, cacti, shrubs (thousands in one draw call) | `world/Props.js`: `makeInstanced` |
| Instanced runway lights with per-instance HDR colours | `world/Runway.js` |
| Instanced cloud billboards + back-to-front sorting | `world/Clouds.js`: `update`, `writeInstances` |
| Level of detail: polar water grid, per-wavelength wave fading, distance-faded ripples | `world/Water.js`: `buildPolarGrid`; `water.vert.glsl` |
| Level of detail for vegetation: near trees use the detailed model, the rest a cheap one; re-bucketed as the camera moves | `world/Foliage.js`: `LodInstances` |
| **Adaptive resolution** (frame-time driven pixel ratio) | `core/Performance.js`: `ResolutionGovernor.update` |
| Shader pre-compilation, constant light count, fixed-step physics | `core/Game.js`: `loadRoute`, `stepPhysics`; `NavLights.js` comment |
| Dynamic `CanvasTexture` updated at 30 Hz without mipmaps (live cockpit instruments) | `sim/SimSession.js`: constructor, `updateHUD` |

### 10. Camera
| Concept | Where |
|---|---|
| Chase camera with lag (exponential smoothing), partial banking, ground clamp | `core/CameraRig.js`: `update` |
| Speed-based field of view, boost FOV and camera shake | `CameraRig.js`: `update` |
| Cockpit / first-person view (eye point in aircraft space, head look) | `CameraRig.js`: `setMode`, `updateCockpit` |
| Simulator cockpit: head sinks under g, runway rumble, stall buffet | `CameraRig.js`: `updateCockpit` |
| 2D projections drawn on canvases: north-up moving map (orthographic, seen from above), ILS needles from angles to the runway | `sim/SimHUD.js`: `drawMap`, `drawIls`; `sim/SimSession.js`: `approachInfo` |
| Free-look with the mouse (Pointer Lock API) | `core/Input.js`; `CameraRig.js` |
| Perspective projection and world → screen projection (HUD ring marker) | `ui/HUD.js`: `updateMarker` |
| Sky, stars and aurora domes that follow the camera (infinitely far away) | `world/Sky.js`, `Stars.js`, `Aurora.js`: `update` |

### 11. Audio (Web Audio API, fully procedural)
| Sound | Where |
|---|---|
| Engine hum: oscillators → low-pass filter → tremolo; pitch follows throttle | `core/AudioEngine.js`: `buildEngine`, `update` |
| Wind noise rising with speed (band-pass filtered white noise) | `AudioEngine.js`: `buildWind`, `update` |
| Ocean ambience (swelling low-passed noise), arctic pad, desert gusts | `AudioEngine.js`: `buildAmbience` |
| Ring chime, touchdown thump and tyre squeal, crash, gear motor, success fanfare | `AudioEngine.js`: `chime`, `touchdown`, `crash`, `gear`, `success` |
| Simulator: engine pitch from RPM, stall-warning horn, tyre rumble, flap motor | `AudioEngine.js`: `buildSim`, `update` |
| Autoplay policy (start after first click), mute toggle (M) | `AudioEngine.js`: `init`, `toggleMute`; `core/Game.js` constructor |

### 12. Simulation and interaction
| Concept | Where |
|---|---|
| Arcade flight model: thrust, drag, lift ∝ v², banked turns, sink when slow, no stalls | `aircraft/FlightModel.js`: `update` |
| Soft world boundary, soft water floor, collision probes | `FlightModel.js`: `update`; `core/Game.js`: `applyWaterFloor`, `checkCollision` |
| Ring pass detection (plane crossing + radius test) | `world/Rings.js`: `checkPass` |
| Landing: touchdown checks, ground roll, braking, results | `core/Landing.js`; `FlightModel.js`: `updateGround`; `Game.js`: `stepPhysics`, `finishRoute` |
| PAPI glide-slope lights | `world/Runway.js`: `update` |
| UI state machine (title → routes → flying ↔ paused → results) | `core/Game.js` |

### 13. Flight simulation (simulator mode)
| Concept | Where |
|---|---|
| **6-degree-of-freedom rigid body**: Newton's 2nd law for translation, **Euler's equations** `I dω/dt = M − ω × Iω` for rotation, quaternion orientation, 120 Hz fixed step | `sim/SimFlightModel.js`: `update` |
| **Aerodynamic coefficients**: angle of attack and sideslip from the air-relative velocity, lift/drag/side force = coefficient × ½ρV² × S | `SimFlightModel.js`: `update`, `PLANE` |
| **Lift curve with stall** (linear → rounded CLmax → post-stall flat plate), flaps raise CLmax | `SimFlightModel.js`: `liftCoefficient` |
| **Per-wing-half lift**: roll damping, wing drop at the stall, spins | `SimFlightModel.js`: `update` (wing-half loop) |
| **Stability derivatives**: pitch stability, weathercock, dihedral effect, adverse yaw, rate damping; elevator trim | `SimFlightModel.js`: `PLANE`, `update` |
| Induced drag `CL²/(πeA)` and **ground effect** | `SimFlightModel.js`: `update` |
| Engine and fixed-pitch propeller: thrust vs. airspeed, RPM lag, slipstream over the tail, torque and P-factor | `SimFlightModel.js`: `update` |
| **Landing gear as spring-dampers** (Hooke's law + damping), tyre friction, brakes, nose-wheel steering, torques about the CG | `SimFlightModel.js`: `update` (gear loop) |
| ISA air density vs. altitude, indicated vs. true airspeed | `SimFlightModel.js`: `airDensity`, `update` |
| **Wind**: logarithmic boundary-layer profile, gusts and turbulence as Ornstein-Uhlenbeck (Dryden-like) random processes | `sim/Wind.js` |
| Trimmed-flight solver (angle of attack, elevator trim, throttle for level flight) | `SimFlightModel.js`: `trimFor` |
| Accelerometer (specific force): g-meter and the turn coordinator's slip ball | `SimFlightModel.js`: `update` |
| Instructor state machine for the traffic pattern, landing grading | `sim/SimSession.js`: `updateLesson`, `finishLanding` |
| Analogue gauges drawn with the Canvas 2D API (needle rotations, horizon transform) | `sim/Instruments.js` |
| Gamepad API, mouse yoke via Pointer Lock deltas | `core/Input.js`: `pollGamepad`, `updateSim` |

---

## Mapping to the lab requirements

| Requirement | Implemented by |
|---|---|
| **Immersive** | Chase camera with lag and banking, cockpit view (C), sky domes and per-route fog, speed FOV, bloom and lens flare, procedural sound |
| **Interactive** | Keyboard, mouse and gamepad flight, route menu, pause menu, checkpoint rings, Canyon landing, flight simulator with lessons and landing grading |
| **Imaginative** | Aurora, sunset water and glowing ring shaders, vapour trails, captions at each route's moment |
| **3D modelling** | Procedural aircraft (scene graph), terrain, islands, mountains, instanced trees and rocks, runway, lighthouse, birds |
| **Animation and transformations** | Propeller, control surfaces, gear, pulsing and bursting rings, aurora, waves, birds, lighthouse beam, debug panel (T) |
| **Light sources** | Directional sun or moon (shadows), hemisphere fill, nav PointLights, lighthouse SpotLight, runway PointLights |
| **Sound (bonus)** | Engine, wind, chime, ocean ambience, touchdown, mute (M), starts after the first click |

## Credits
- three.js (MIT) and simplex-noise (MIT), installed from npm.
- Aurora technique (layered raymarch through triangle-wave noise) adapted from **"Auroras" by nimitz** on Shadertoy (CC BY-NC-SA 3.0); credited in `src/shaders/aurora.frag.glsl`.
- Everything else (models, textures, shaders, sounds) was written for this project.
