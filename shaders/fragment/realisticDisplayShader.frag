#version 300 es
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

in vec2 fragCoord;    // pixel
in vec2 texCoord;     // this normalized

in vec2 texCoordXmY0; // left
in vec2 texCoordX0Ym; // down
in vec2 texCoordXpY0; // right
in vec2 texCoordX0Yp; // up

in vec2 onScreenUV;

uniform sampler2D baseTex;
uniform sampler2D waterTex;
uniform isampler2D wallTex;
uniform sampler2D lightTex;
uniform sampler2D noiseTex;
uniform sampler2D surfaceTextureMap;
uniform sampler2D curlTex;
uniform sampler2D lightningTex;
uniform sampler2D lightningDataTex;

uniform sampler2D ambientLightTex;

uniform vec2 aspectRatios; // [0] Sim       [1] canvas

#define URBAN 0
#define FIRE_FOREST 1
#define SNOW_FOREST 2
#define FOREST 3
#define INDUS 4


uniform vec2 resolution; // sim resolution
uniform vec2 texelSize;

uniform float cellHeight; // in meters

uniform float dryLapse;
uniform float sunAngle;

uniform float minShadowLight;

uniform vec3 view;   // Xpos  Ypos    Zoom
uniform vec4 cursor; // Xpos   Ypos  Size   type

uniform float displayVectorField;

uniform float iterNum;

out vec4 fragmentColor;

#include "common.glsl"

#include "commonDisplay.glsl"

vec4 base, water;
ivec4 wall;
float lightIntensity;

vec3 color;
float opacity = 1.0;

vec3 emittedLight = vec3(0.); // pure light, like lightning

float shadowLight;

vec3 onLight; // extra light that lights up objects, just like sunlight and shadowlight


const vec3 bareDrySoilCol = pow(vec3(0.85, 0.60, 0.40), vec3(GAMMA));
const vec3 bareWetSoilCol = pow(vec3(0.5, 0.2, 0.1), vec3(GAMMA));
const vec3 greenGrassCol = pow(vec3(0.0, 0.7, 0.2), vec3(GAMMA));
const vec3 dryGrassCol = pow(vec3(0.843, 0.588, 0.294), vec3(GAMMA));


vec4 surfaceTexture(int index, vec2 pos)
{
#define numTextures 5.;             // number of textures in the map
  const float texRelHeight = 1. / numTextures;
  pos.y = clamp(pos.y, 0.01, 0.99); // make sure position is within the subtexture
  pos /= numTextures;
  pos.y += float(index) * texRelHeight;
  return texture(surfaceTextureMap, pos);
}


vec3 getWallColor(float depth)
{
  vec3 vegetationCol = mix(greenGrassCol, dryGrassCol, max(1.0 - water[SOIL_MOISTURE] * (1. / fullGreenSoilMoisture), 0.)); // green to brown

  vec3 bareSoilCol = mix(bareDrySoilCol, bareWetSoilCol, map_rangeC(water[SOIL_MOISTURE], 0.0, 20.0, 0.0, 1.0));

  vec3 surfCol = mix(bareSoilCol, vegetationCol, min(float(wall[VEGETATION]) / 50., 1.));

  const vec3 rockCol = vec3(0.70);                                 // gray rock

  vec3 color = mix(surfCol, rockCol, clamp(depth * 0.35, 0., 1.)); // * 0.15


  color *= texture(noiseTex, vec2(texCoord.x * resolution.x, texCoord.y * resolution.y) * 0.2).rgb;                                   // add noise texture

  color = mix(color, vec3(1.0), clamp(min(water[SNOW], fullWhiteSnowHeight) / fullWhiteSnowHeight - max(depth * 0.3, 0.), 0.0, 1.0)); // mix in white for snow cover

  return color;
}

// Returns a per-bolt colour sampled from the realistic lightning palette.
// Colour depends on atmospheric scattering: dry/clear → blue-white; humid → violet;
// hail storms → blue; dusty/smoky air → yellow; long atmospheric path → red.
// Seed from lightningStartIterNum so each new bolt gets a fresh colour roll.
vec3 getLightningColor(float boltSeed)
{
    float r = random2d(vec2(boltSeed * 0.001, boltSeed * 0.00137));
    if (r < 0.40) return vec3(0.60, 0.75, 1.00); // blue-white  ~40% — clear/dry air
    if (r < 0.65) return vec3(0.65, 0.45, 1.00); // violet      ~25% — humid air
    if (r < 0.80) return vec3(1.00, 0.90, 0.65); // warm white  ~15% — very intense bolt
    if (r < 0.92) return vec3(0.30, 0.50, 1.00); // blue        ~12% — hail/cold storms
    if (r < 0.97) return vec3(1.00, 0.93, 0.72); // yellow      ~ 5% — dusty/smoky air
    return             vec3(1.00, 0.78, 0.72);   // red/pink    ~ 3% — long path through rain
}

float calcLightningTime(float startIterNum)
{
  float lightningTime = iterNum - startIterNum;
  return lightningTime / 5.0; // 30.0    0. to 1. leader stage, 1. + Flash stage
}

float lightningIntensityOverTime(float Tin, vec2 lightningPos, float intensity)
{
  float T0 = Tin - 1.;

  float repeatPeriod = map_range(random2d(lightningPos), 0., 1., 1.5, 3.0);                                            // 2.5
  float numFlashes = floor(map_range(random2d(lightningPos * 2.737250), 0., 1., 1.0, max(intensity - 0.5, 0.) * 2.0)); // 0.4

  float minT = max(T0 - (repeatPeriod * numFlashes), 0.);

  float T = max(mod(T0, repeatPeriod), minT);

  return max((1. / (0.05 + pow(T * 2.0, 3.))) - 0.005, 0.) * pow(intensity, 2.0); // fading out curve
}

// ── Lightning SDF primitives ──────────────────────────────────────────────

float spiderSegSDF(vec2 p, vec2 a, vec2 b) {
  vec2  ab = b - a;
  float t  = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - a - t * ab);
}

float segGlow(float d, float coreR) {
  return exp(-d / coreR) * 2.0
       + exp(-d / (coreR * 3.5)) * 0.18
       + exp(-d / (coreR * 6.0)) * 0.04;
}

// ── Spider / cloud-to-cloud lightning ────────────────────────────────────

vec3 displaySpiderLightning(vec2 lightningPos, float T, float boltSeed)
{
  const float mainCoreR  = 0.000375;
  const float subCoreR   = mainCoreR * 0.60;
  const float spiderStep = 0.013;
  const int   MSEGS      = 40;
  const int   SSEGS      = 16;

  float spiderProg  = clamp(T, 0.0, 1.0);
  float flashBright = T < 1.0
      ? 1500.0 * spiderProg
      : max(500.0 / (0.05 + pow(T * 4.0, 2.5)), 0.0);
  if (flashBright < 0.0001) return vec3(0.0);

  vec2 p      = vec2(texCoord.x * aspectRatios[0], texCoord.y);
  vec2 origin = vec2(lightningPos.x * aspectRatios[0], lightningPos.y);

  float totalGlow = 0.0;
  vec2  mVerts[41];
  vec2  sVerts[17];

  for (int b = 0; b < 3; b++) {
    float bs = boltSeed + float(b) * 137.51;

    float goRight   = random2d(vec2(bs * 0.00113, bs * 0.00173 + 1.7)) > 0.5 ? 1.0 : -1.0;
    float mainAngle = goRight > 0.0 ? 0.0 : PI;
    mainAngle += (random2d(vec2(bs * 0.00217, bs * 0.00319)) - 0.5) * 0.4;

    float ang = mainAngle;
    mVerts[0] = origin;

    for (int i = 0; i < MSEGS; i++) {
      float r1 = random2d(vec2(bs * 0.00371 + float(i) * 0.0937, bs * 0.00591 + float(i) * 0.0517));
      ang += (r1 - 0.5) * 2.5;
      ang -= (ang - mainAngle) * 0.12;
      ang -= sin(ang) * 0.28;
      mVerts[i + 1] = mVerts[i] + vec2(cos(ang), sin(ang)) * spiderStep;
    }

    vec2  tip        = mVerts[MSEGS];
    vec2  tipTC      = vec2(tip.x / aspectRatios[0], clamp(tip.y, 0.0, 1.0));
    float cloudAtTip = texture(waterTex, tipTC)[CLOUD];

    if (cloudAtTip >= 0.008) {
      float minD = 1e10, minFade = 0.0;
      for (int i = 0; i < MSEGS; i++) {
        float t0   = float(i) / float(MSEGS);
        float fade = clamp((spiderProg - t0) * float(MSEGS), 0.0, 1.0);
        float d    = spiderSegSDF(p, mVerts[i], mVerts[i + 1]);
        if (d < minD) { minD = d; minFade = fade; }
      }
      totalGlow += segGlow(minD, mainCoreR) * minFade;

      for (int s = 0; s < 3; s++) {
        float ss       = bs + float(s) * 73.37;
        int   spawnIdx = min(int(random2d(vec2(ss * 0.00413, ss * 0.00237)) * 30.0) + 5, MSEGS - 1);
        float subAng   = mainAngle;
        sVerts[0]      = mVerts[spawnIdx];

        for (int i = 0; i < SSEGS; i++) {
          float r1 = random2d(vec2(ss * 0.00511 + float(i) * 0.0937, ss * 0.00391 + float(i) * 0.0711));
          subAng += (r1 - 0.5) * 2.5;
          subAng -= (subAng - mainAngle) * 0.12;
          subAng -= sin(subAng) * 0.28;
          sVerts[i + 1] = sVerts[i] + vec2(cos(subAng), sin(subAng)) * spiderStep;
        }

        vec2  sTip       = sVerts[SSEGS];
        vec2  sTipTC     = vec2(sTip.x / aspectRatios[0], clamp(sTip.y, 0.0, 1.0));
        float cloudAtSub = texture(waterTex, sTipTC)[CLOUD];
        if (cloudAtSub >= 0.008) {
          float sMinD = 1e10, sMinFade = 0.0;
          for (int i = 0; i < SSEGS; i++) {
            float t0   = float(i) / float(SSEGS);
            float fade = clamp((spiderProg - t0) * float(SSEGS), 0.0, 1.0);
            float d    = spiderSegSDF(p, sVerts[i], sVerts[i + 1]);
            if (d < sMinD) { sMinD = d; sMinFade = fade; }
          }
          totalGlow += segGlow(sMinD, subCoreR) * sMinFade * 0.44;
        }
      }
    }
  }

  return getLightningColor(boltSeed) * totalGlow * flashBright;
}

// ── Cloud-to-ground lightning ─────────────────────────────────────────────

vec3 displayCGLightning(vec2 lightningPos, float T, float boltSeed)
{
  const float mainCoreR   = 0.00045;
  const float branchCoreR = 0.000375;
  const float armCoreR    = branchCoreR * 0.85;
  const float armSubCoreR = branchCoreR * 0.55;
  const int   MAIN_SEGS   = 48;
  const int   SIDE_SEGS   = 24;
  const int   ARM_SEGS    = 40;
  const int   ASUB_SEGS   = 16;

  float spiderProg  = clamp(T, 0.0, 1.0);
  float flashBright = T < 1.0
      ? 1125.0 * spiderProg
      : max(300.0 / (0.05 + pow(T * 4.0, 2.5)), 0.0);
  if (flashBright < 0.0001) return vec3(0.0);

  vec2  p       = vec2(texCoord.x * aspectRatios[0], texCoord.y);
  vec2  origin  = vec2(lightningPos.x * aspectRatios[0], lightningPos.y);
  float stepLen = lightningPos.y / float(MAIN_SEGS);

  float totalGlow = 0.0;

  // Main bolt: 48 near-vertical segments downward from cloud base
  vec2  cgVerts[49];
  cgVerts[0] = origin;
  float cgAng = -PI * 0.5;

  for (int i = 0; i < MAIN_SEGS; i++) {
    float r1 = random2d(vec2(boltSeed * 0.00371 + float(i) * 0.0937, boltSeed * 0.00591 + float(i) * 0.0517));
    cgAng += (r1 - 0.5) * 1.6;
    cgAng -= (cgAng + PI * 0.5) * 0.30;
    cgVerts[i + 1] = cgVerts[i] + vec2(cos(cgAng), sin(cgAng)) * stepLen;
  }

  {
    float minD = 1e10, minFade = 0.0;
    for (int i = 0; i < MAIN_SEGS; i++) {
      float t0   = float(i) / float(MAIN_SEGS);
      float fade = clamp((spiderProg - t0) * float(MAIN_SEGS), 0.0, 1.0);
      float d    = spiderSegSDF(p, cgVerts[i], cgVerts[i + 1]);
      if (d < minD) { minD = d; minFade = fade; }
    }
    totalGlow += segGlow(minD, mainCoreR) * minFade;
  }

  // 4 downward side branches, 24 segments each
  vec2 sbVerts[25];
  for (int sb = 0; sb < 4; sb++) {
    float sbs     = boltSeed + float(sb) * 137.51 + 500.0;
    int   fromIdx = min(int(random2d(vec2(sbs * 0.00113, sbs * 0.00173)) * 44.0) + 2, MAIN_SEGS - 2);

    float branchLen = random2d(vec2(sbs * 0.00217, sbs * 0.00319)) * 0.20 + 0.05;
    float sbStep    = lightningPos.y * branchLen / float(SIDE_SEGS);
    float sbAng     = -PI * 0.5 + (random2d(vec2(sbs * 0.00411, sbs * 0.00591)) - 0.5) * PI * 1.6;
    sbVerts[0]      = cgVerts[fromIdx];

    for (int i = 0; i < SIDE_SEGS; i++) {
      float r1 = random2d(vec2(sbs * 0.00511 + float(i) * 0.0937, sbs * 0.00391 + float(i) * 0.0711));
      sbAng += (r1 - 0.5) * 1.6;
      sbAng -= (sbAng + PI * 0.5) * 0.30;
      sbVerts[i + 1] = sbVerts[i] + vec2(cos(sbAng), sin(sbAng)) * sbStep;
    }

    float sbMinD = 1e10, sbMinFade = 0.0;
    for (int i = 0; i < SIDE_SEGS; i++) {
      float t0   = float(i) / float(SIDE_SEGS);
      float fade = clamp((spiderProg - t0) * float(SIDE_SEGS), 0.0, 1.0);
      float d    = spiderSegSDF(p, sbVerts[i], sbVerts[i + 1]);
      if (d < sbMinD) { sbMinD = d; sbMinFade = fade * (1.0 - t0 * 0.55); }
    }
    totalGlow += segGlow(sbMinD, branchCoreR) * sbMinFade * 0.50;
  }

  // 2 horizontal cloud arms, 40 segments each (connect CG to spider discharge)
  vec2 armVerts[41];
  vec2 asubVerts[17];
  for (int ca = 0; ca < 2; ca++) {
    float cas   = boltSeed + float(ca) * 137.51 + 1000.0;
    int   caIdx = min(int(random2d(vec2(cas * 0.00113, cas * 0.00173)) * 6.0), 5);

    float goRight = random2d(vec2(cas * 0.00317, cas * 0.00419)) > 0.5 ? 1.0 : -1.0;
    float ccAng   = goRight > 0.0 ? 0.0 : PI;
    ccAng += (random2d(vec2(cas * 0.00513, cas * 0.00217)) - 0.5) * 0.4;

    float armAng = ccAng;
    armVerts[0]  = cgVerts[caIdx];

    for (int i = 0; i < ARM_SEGS; i++) {
      float r1 = random2d(vec2(cas * 0.00371 + float(i) * 0.0937, cas * 0.00591 + float(i) * 0.0517));
      armAng += (r1 - 0.5) * 2.5;
      armAng -= (armAng - ccAng) * 0.12;
      armAng -= sin(armAng) * 0.28;
      armVerts[i + 1] = armVerts[i] + vec2(cos(armAng), sin(armAng)) * 0.013;
    }

    vec2  armTip     = armVerts[ARM_SEGS];
    vec2  armTipTC   = vec2(armTip.x / aspectRatios[0], clamp(armTip.y, 0.0, 1.0));
    float cloudAtArm = texture(waterTex, armTipTC)[CLOUD];
    if (cloudAtArm >= 0.008) {
      float armMinD = 1e10, armMinFade = 0.0;
      for (int i = 0; i < ARM_SEGS; i++) {
        float t0   = float(i) / float(ARM_SEGS);
        float fade = clamp((spiderProg - t0) * float(ARM_SEGS), 0.0, 1.0);
        float d    = spiderSegSDF(p, armVerts[i], armVerts[i + 1]);
        if (d < armMinD) { armMinD = d; armMinFade = fade; }
      }
      totalGlow += segGlow(armMinD, armCoreR) * armMinFade * 0.65;

      // 2 sub-branches per cloud arm, 16 segments each
      for (int as = 0; as < 2; as++) {
        float ass       = cas + float(as) * 73.37;
        int   aspawnIdx = min(int(random2d(vec2(ass * 0.00413, ass * 0.00237)) * 30.0) + 5, ARM_SEGS - 1);
        float asubAng   = ccAng;
        asubVerts[0]    = armVerts[aspawnIdx];

        for (int i = 0; i < ASUB_SEGS; i++) {
          float r1 = random2d(vec2(ass * 0.00511 + float(i) * 0.0937, ass * 0.00391 + float(i) * 0.0711));
          asubAng += (r1 - 0.5) * 2.5;
          asubAng -= (asubAng - ccAng) * 0.12;
          asubAng -= sin(asubAng) * 0.28;
          asubVerts[i + 1] = asubVerts[i] + vec2(cos(asubAng), sin(asubAng)) * 0.013;
        }

        vec2  asubTip     = asubVerts[ASUB_SEGS];
        vec2  asubTipTC   = vec2(asubTip.x / aspectRatios[0], clamp(asubTip.y, 0.0, 1.0));
        float cloudAtAsub = texture(waterTex, asubTipTC)[CLOUD];
        if (cloudAtAsub >= 0.008) {
          float asubMinD = 1e10, asubMinFade = 0.0;
          for (int i = 0; i < ASUB_SEGS; i++) {
            float t0   = float(i) / float(ASUB_SEGS);
            float fade = clamp((spiderProg - t0) * float(ASUB_SEGS), 0.0, 1.0);
            float d    = spiderSegSDF(p, asubVerts[i], asubVerts[i + 1]);
            if (d < asubMinD) { asubMinD = d; asubMinFade = fade; }
          }
          totalGlow += segGlow(asubMinD, armSubCoreR) * asubMinFade * 0.30;
        }
      }
    }
  }

  return getLightningColor(boltSeed) * totalGlow * flashBright;
}


float saturate(float x) { return min(1.0, max(0.0, x)); }
vec3 saturate(vec3 x) { return min(vec3(1., 1., 1.), max(vec3(0., 0., 0.), x)); }


vec3 bump3y(vec3 x, vec3 yoffset)
{
  vec3 y = vec3(1., 1., 1.) - x * x;
  y = saturate(y - yoffset);
  return y;
}
vec3 spectral_zucconi(float w)
{
  // w: [400, 700] wavelenght(nm)
  // x: [0,   1]
  float x = saturate((w - 400.0) / 300.0);
  const vec3 cs = vec3(3.54541723, 2.86670055, 2.29421995);
  const vec3 xs = vec3(0.69548916, 0.49416934, 0.28269708);
  const vec3 ys = vec3(0.02320775, 0.15936245, 0.53520021);
  return bump3y(cs * (x - xs), ys);
}


vec4 getAirColor(vec2 fragCoordIn)
{
  vec2 bndFragCoord = vec2(fragCoordIn.x, clamp(fragCoordIn.y, 0., resolution.y)); // bound y within range
  base = bilerpWallVis(baseTex, wallTex, bndFragCoord);
  wall = texture(wallTex, bndFragCoord * texelSize);                               // texCoord
  water = bilerpWallVis(waterTex, wallTex, bndFragCoord);
  lightIntensity = texture(lightTex, bndFragCoord * texelSize)[0] / standardSunBrightness;

  ivec4 wallX0Ym = texture(wallTex, texCoordX0Ym);

  float realTemp = potentialToRealT(base[TEMPERATURE]);

  bool nightTime = abs(sunAngle) > 85.0 * deg2rad; // false = day time

  shadowLight = minShadowLight;

  // fragmentColor = vec4(vec3(light),1); return; // View light texture for debugging

  float cloudwater = water[CLOUD];

  vec3 cloudCol = vec3(1.0 / (cloudwater * 0.005 + 1.0)); // 0.10 white to black

  float cloudDensity = max(cloudwater * 13.6, 0.0);

  float totalDensity = cloudDensity + water[PRECIPITATION] * 0.8; // visualize precipitation


  // float cloudOpacity = clamp(cloudwater * 4.0, 0.0, 1.0);
  float cloudOpacity = clamp(1.0 - (1.0 / (1. + totalDensity)), 0.0, 1.0);

  float cloudScattering = clamp(map_range(abs(sunAngle), 75. * deg2rad, 90. * deg2rad, 0., 1.), 0., 1.);

  // Altitude-based colour for directly-lit cloud pixels only.
  // Injected via onLight * lightIntensity so only lit faces change; shadows stay untouched.
  float y = texCoord.y;
  vec3 colPurple = vec3(0.65, 0.38, 0.82);
  vec3 colPink   = vec3(1.00, 0.50, 0.60);
  vec3 colOrange = vec3(1.00, 0.52, 0.22);
  vec3 colYellow = vec3(1.00, 0.88, 0.48);
  vec3 altColor  = mix(colPurple,
                     mix(colPink,
                       mix(colOrange, colYellow, smoothstep(0.45, 0.70, y)),
                     smoothstep(0.20, 0.45, y)),
                   smoothstep(0.05, 0.20, y));
  onLight += altColor * cloudScattering * cloudOpacity * lightIntensity * y * 6.0;

  // Extra white boost for the very top (high altitude, lit faces)
  float altFactor = clamp((texCoord.y - 0.50) / 0.50, 0.0, 1.0);
  onLight += vec3(cloudScattering * cloudOpacity * altFactor * altFactor * lightIntensity * 8.0);

  const vec3 smokeThinCol = vec3(0.8, 0.51, 0.26);
  const vec3 smokeThickCol = vec3(0., 0., 0.);


  float smokeOpacity = clamp(1. - (1. / (water[SMOKE] + 1.)), 0.0, 1.0);
  float fireIntensity = clamp((smokeOpacity - 0.8) * 25., 0.0, 1.0);

  vec3 fireCol = hsv2rgb(vec3(fireIntensity * 0.008, 0.98, 5.0)) * 1.0; // 1.0, 0.7, 0.0

  vec3 smokeOrFireCol = mix(mix(smokeThinCol, smokeThickCol, smokeOpacity), fireCol, fireIntensity);

  shadowLight += fireIntensity * 2.5;                                                                                 // 1.5

  float opacity = 1. - (1. - smokeOpacity) * (1. - cloudOpacity);                                                     // alpha blending
  vec3 color = (smokeOrFireCol * smokeOpacity / opacity) + (cloudCol * cloudOpacity * (1. - smokeOpacity) / opacity); // color blending


  vec4 lightningData = texture(lightningDataTex, vec2(0.5));
  vec2 lightningPos = lightningData.xy;
  float lightningStartIterNum = lightningData[START_ITERNUM];

  float lightningTime = calcLightningTime(lightningStartIterNum);
  float currentLightningIntensity = lightningIntensityOverTime(lightningTime, lightningPos, lightningData[INTENSITY]);


  if (lightningData[INTENSITY] > 1.0) { // CG
    vec3  cgLight     = displayCGLightning(lightningPos, lightningTime, lightningStartIterNum);
    float cgDepth     = random2d(vec2(lightningStartIterNum * 0.00137, lightningStartIterNum * 0.00271));
    float cgOcclusion = pow(max(1.0 - cloudOpacity, 0.0), cgDepth * 4.5);
    emittedLight += cgLight * cgOcclusion;
  } else if (lightningData[INTENSITY] > 0.5) { // spider / CC
    emittedLight += displaySpiderLightning(lightningPos, lightningTime, lightningStartIterNum);
    emittedLight /= 1.0 + cloudDensity * 20.0;
  }

  // Cloud illumination falloff centred on the strike origin
  {
    vec2  ldist    = vec2((lightningPos.x - texCoord.x) * aspectRatios[0], lightningPos.y * 0.5 - texCoord.y);
    float ldistSq  = dot(ldist, ldist);
    float lOnLight = 0.0006 / (ldistSq + 0.008);
    lOnLight *= currentLightningIntensity;
    onLight += lOnLight * getLightningColor(lightningStartIterNum);
  }

  return vec4(color, opacity);
}

float rand(float n) { return fract(sin(n) * 43758.5453123); }

void main()
{
  vec2 bndFragCoord = vec2(fragCoord.x, clamp(fragCoord.y, 0., resolution.y)); // bound y within range
  base = bilerpWallVis(baseTex, wallTex, bndFragCoord);
  wall = texture(wallTex, bndFragCoord * texelSize);                           // texCoord
  water = bilerpWallVis(waterTex, wallTex, bndFragCoord);
  lightIntensity = texture(lightTex, bndFragCoord * texelSize)[0] / standardSunBrightness;

  ivec4 wallX0Ym = texture(wallTex, texCoordX0Ym);

  float realTemp = potentialToRealT(base[TEMPERATURE]);

  bool nightTime = abs(sunAngle) > 85.0 * deg2rad; // false = day time

  shadowLight = minShadowLight;

  // fragmentColor = vec4(vec3(light),1); return; // View light texture for debugging

  float cloudwater = water[CLOUD];

  if (texCoord.y < 0.) {                                     // < texelSize.y below simulation area

    float depth = float(-wall[VERT_DISTANCE]) - fragCoord.y; // -1.0?

    color = getWallColor(depth);

    lightIntensity = texture(lightTex, vec2(texCoord.x, texelSize.y))[0] / standardSunBrightness; // sample lowest part of sim area
    lightIntensity *= pow(0.5, -fragCoord.y);                                                     // 0.5 should be same as in lightingshader deeper is darker

  } else if (texCoord.y > 1.0) {                                                                  // above simulation area
    // color = vec3(0); // no need to set
    opacity = 0.0;                  // completely transparent
  } else if (wall[DISTANCE] == 0) { // is wall
                                    // color = getWallColor(texCoord);

    ivec4 wallXmY0 = texture(wallTex, texCoordXmY0);
    ivec4 wallXpY0 = texture(wallTex, texCoordXpY0);

    switch (wall[TYPE]) {
      // case WALLTYPE_INERT:
      //   color = vec3(0, 0, 0);
      //   break;

    case WALLTYPE_RUNWAY:

      if (wall[VERT_DISTANCE] == 0) {
        vec2 modTexCoord = mod(texCoord * resolution, 1.0);

        color = vec3(0.1);
        color *= texture(noiseTex, vec2(texCoord.x * resolution.x, texCoord.y * resolution.y) * 0.2).rgb; // add noise texture

        if (length(modTexCoord - vec2(0.7, 0.97)) < 0.03) {                                               // side lights
          onLight += vec3(1., 0.8, 0.3) * 300.0;
        }

        if (abs(mod(-iterNum - floor(texCoord.x * resolution.x), 150.0)) < 1.0 && length(modTexCoord - vec2(0.2, 0.98)) < 0.02) {
          onLight += vec3(0., 1.0, 0.) * 5000.0;
        }

        break;
      }

    case WALLTYPE_URBAN:
    case WALLTYPE_INDUSTRIAL:
    case WALLTYPE_FIRE:
    case WALLTYPE_LAND:

      // horizontally interpolate depth value
      float interpDepth = mix(mix(float(-wallXmY0[VERT_DISTANCE]), float(-wall[VERT_DISTANCE]), clamp(fract(fragCoord.x) + 0.5, 0.5, 1.)), float(-wallXpY0[VERT_DISTANCE]), clamp(fract(fragCoord.x) - 0.5, 0., 0.5));
      float depth = interpDepth - fract(fragCoord.y); // - 1.0 ?

      color = getWallColor(depth);

      break;
    case WALLTYPE_WATER:

      // Precomputed values (tweak to taste)
      // Frequencies
      const int numWaveComp = 5;
      const float freqs[numWaveComp] = float[numWaveComp](2.3, 3.7, 5.1, 7.6, 21.7);
      // Amplitudes
      const float amps[numWaveComp] = float[numWaveComp](0.05, 0.03, 0.02, 0.015, 0.004);
      // Speeds
      const float speeds[numWaveComp] = float[numWaveComp](0.006, 0.011, 0.018, 0.025, 0.05);
      // Phases (in radians)
      const float phases[numWaveComp] = float[numWaveComp](1.2, 3.9, 0.7, 5.1, 3.1);

      // Sum up the components
      float waveSignalL = 0.0;
      float waveSignalR = 0.0;

      for (int i = 0; i < numWaveComp; i++) {
        waveSignalL += sin(fragCoord.x * freqs[i] + iterNum * speeds[i] + phases[i]) * amps[i];
        waveSignalR += sin(fragCoord.x * freqs[i] - iterNum * speeds[i] + phases[i]) * amps[i];
      }

      vec4 baseX0Yp = texture(baseTex, texCoordX0Yp);
      float windSpeed = baseX0Yp[VX] * 10.;

      // combine based on wind direction
      float waterLevel = 0.8 + waveSignalL * max(-windSpeed, 0.) + waveSignalR * max(windSpeed, 0.);

      if (wall[VERT_DISTANCE] == 0 && fract(fragCoord.y) > waterLevel) { // air
        vec4 airColor = getAirColor(fragCoord + vec2(0., 0.5));

        opacity = airColor.a;
        color = airColor.rgb;
      } else {
        color = vec3(0, 0.5, 1.0); // water
      }

      // draw 45° slopes under water

      float localX = fract(fragCoord.x);
      float localY = fract(fragCoord.y);

      if (wallXmY0[DISTANCE] == 0 && wallXmY0[TYPE] != WALLTYPE_WATER && (fragCoord.y < 1. || wallX0Ym[TYPE] != WALLTYPE_WATER)) { // wall to the left and below
        if (localX + localY < 1.0) {
          opacity = 1.0;
          water = texture(waterTex, texCoord);
          color = getWallColor(float(-wall[VERT_DISTANCE]) - localY);
          shadowLight = minShadowLight;
        }
      }
      if (wallXpY0[DISTANCE] == 0 && wallXpY0[TYPE] != WALLTYPE_WATER && (fragCoord.y < 1. || wallX0Ym[TYPE] != WALLTYPE_WATER)) { // wall to the right and below
        if (localY - localX < 0.0) {
          opacity = 1.0;
          water = texture(waterTex, texCoord);
          color = getWallColor(float(-wall[VERT_DISTANCE]) - localY);
          shadowLight = minShadowLight;
        }
      }

      break;
    }
  } else { // air

    vec4 airColor = getAirColor(fragCoord);

    opacity = airColor.a;
    color = airColor.rgb;


    vec2 rainbowCenter = vec2(0.0, -1.5 + abs(sunAngle) * 0.60);

    float centerDist = length(onScreenUV - rainbowCenter) * 1.3;

    const float cameraHeight = 1.0;

    float angle = atan(centerDist / cameraHeight) * rad2deg;

    float waveLength = map_range(angle, 40.0, 42.0, 400., 700.);

    float rainSnowFactor = map_rangeC(KtoC(realTemp), 0.0, 5.0, 0.0, 1.0); // only rain if above freezing

    vec3 rainbowCol = spectral_zucconi(waveLength) * min(pow(lightIntensity, 2.0) * 1.9, 1.0) * min(water[PRECIPITATION] * 3.0, 1.0) * rainSnowFactor * 0.7;

    emittedLight += rainbowCol;
    opacity = max(opacity - length(rainbowCol), 0.); // remove some white rain to prevent overbrightening and increase color saturation


    if (wall[VERT_DISTANCE] >= 0 && wall[VERT_DISTANCE] < 10) { // near surface
      float localX = fract(fragCoord.x);
      float localY = fract(fragCoord.y);
      // ivec4 wallX0Ym = texture(wallTex, texCoordX0Ym);

#define texAspect 2560. / 4096. // height / width of tree texture
#define maxTreeHeight 40.       // height in meters when vegetation max = 127
#define maxBuildingHeight 400.  // height in meters upto wich the urban texture reaches


      if (wallX0Ym[TYPE] == WALLTYPE_URBAN) {

        float heightAboveGround = localY + float(wall[VERT_DISTANCE] - 1);

        float urbanTexHeightNorm = maxBuildingHeight / cellHeight; // example: 200 / 40 = 5

        float urbanTexCoordX = mod(fragCoord.x, resolution.x) * texAspect / urbanTexHeightNorm;
        float urbanTexCoordY = heightAboveGround / urbanTexHeightNorm;

        // urbanTexCoordY += map_rangeC(float(wallX0Ym[VEGETATION]), 127., 50., 0., 1.0); // building height

        urbanTexCoordY = 1.0 - urbanTexCoordY;

        vec4 texCol = surfaceTexture(URBAN, vec2(urbanTexCoordX, urbanTexCoordY));
        if (texCol.a > 0.5) { // if not transparent

          if (nightTime) {
            shadowLight = 1.0;                 // city lights
            texCol.rgb *= vec3(1.0, 0.8, 0.5); // yellowish windows
          } else {                             // day time
            texCol.rgb *= vec3(0.8, 0.9, 1.0); // Blueish windows

            if (length(texCol.rgb) < 0.1)
              texCol.rgb = texture(noiseTex, fragCoord * 0.3).rgb * 0.3;
          }
          color = texCol.rgb;
          opacity = texCol.a;
        }
      } else if (wallX0Ym[TYPE] == WALLTYPE_INDUSTRIAL) {

        float heightAboveGround = localY + float(wall[VERT_DISTANCE] - 1);

        float urbanTexHeightNorm = maxBuildingHeight / cellHeight; // example: 200 / 40 = 5

        float urbanTexCoordX = mod(fragCoord.x, resolution.x) * texAspect / urbanTexHeightNorm;
        float urbanTexCoordY = heightAboveGround / urbanTexHeightNorm;

        // urbanTexCoordY += map_rangeC(float(wallX0Ym[VEGETATION]), 127., 50., 0., 1.0); // building height

        urbanTexCoordY = 1.0 - urbanTexCoordY;

        vec4 texCol = surfaceTexture(INDUS, vec2(urbanTexCoordX, urbanTexCoordY));
        if (texCol.a > 0.5) { // if not transparent

          if (nightTime) {
            shadowLight = 1.0;                 // city lights
            texCol.rgb *= vec3(1.0, 0.8, 0.5); // yellowish windows
          } else {                             // day time
            texCol.rgb *= vec3(0.8, 0.9, 1.0); // Blueish windows

            if (length(texCol.rgb) < 0.1)
              texCol.rgb = texture(noiseTex, fragCoord * 0.3).rgb * 0.3;
          }
          color = texCol.rgb;
          opacity = texCol.a;
        }
      }


      if (wall[VERT_DISTANCE] == 1) {                                                 // 1 above surface
                                                                                      //  if (wallX0Ym[VERT_DISTANCE] == 0) {

        float treeTexHeightNorm = maxTreeHeight / cellHeight;                         // example: 40 / 120 = 0.333

        float treeTexCoordY = localY / treeTexHeightNorm;                             // full height trees

        treeTexCoordY += map_rangeC(float(wallX0Ym[VEGETATION]), 127., 50., 0., 1.0); // apply trees height depending on vegetation

        float treeTexCoordX = fragCoord.x * texAspect / treeTexHeightNorm;            // static scaled trees

        float heightAboveGround = localY / treeTexHeightNorm;

        treeTexCoordX -= base.x * heightAboveGround * 1.00; // 2.5  trees waving with the wind effect

        treeTexCoordX *= 0.72;                              // Trees only go up to 72% of the texture height
        treeTexCoordY *= 0.72;                              // Trees only go up to 72% of the texture height
        treeTexCoordY = 1. - treeTexCoordY;                 // texture is upside down

        vec4 texCol;
        if (wallX0Ym[TYPE] == WALLTYPE_LAND || wallX0Ym[TYPE] == WALLTYPE_URBAN) { // land below
          vec4 surfaceWater = texture(waterTex, texCoordX0Ym);                     // snow on land below
          float snow = surfaceWater[SNOW];
          if (snow * 0.01 / cellHeight > heightAboveGround)
            texCol = vec4(vec3(1.), 1.);                                                                                                                          // show white snow layer above ground
          else {                                                                                                                                                  // display vegetation
            vec4 treeColor = surfaceTexture(FOREST, vec2(treeTexCoordX, treeTexCoordY));
            vec4 vegetationCol = mix(treeColor, vec4(dryGrassCol, 1.), max(0.5 - surfaceWater[SOIL_MOISTURE] * (0.5 / fullGreenSoilMoisture), 0.) * treeColor.a); // green to brown
            texCol = mix(vegetationCol, surfaceTexture(SNOW_FOREST, vec2(treeTexCoordX, treeTexCoordY)), min(snow / fullWhiteSnowHeight, 1.0));
          }
        } else if (wallX0Ym[TYPE] == WALLTYPE_FIRE) {
          texCol = surfaceTexture(FIRE_FOREST, vec2(treeTexCoordX, treeTexCoordY));
        }
        if (texCol.a > 0.5) { // if not transparent
          color = texCol.rgb;

          shadowLight = minShadowLight;        // make sure trees are dark at night

          if (wallX0Ym[TYPE] == WALLTYPE_FIRE) // fire below
            shadowLight = 1.0;

          opacity = 1. - (1. - opacity) * (1. - texCol.a); // alpha blending
        }

        // draw 45° slopes
        ivec4 wallXmY0 = texture(wallTex, texCoordXmY0);
        ivec4 wallXpY0 = texture(wallTex, texCoordXpY0);

        if (wallXmY0[DISTANCE] == 0 && wall[TYPE] != WALLTYPE_WATER) { // wall to the left and below
          if (localX + localY < 1.0) {
            opacity = 1.0;
            water = texture(waterTex, texCoordX0Ym);
            color = getWallColor(localY - 0.6);
            shadowLight = minShadowLight; // fire should not light ground
          }
        }
        if (wallXpY0[DISTANCE] == 0 && wall[TYPE] != WALLTYPE_WATER) { // wall to the right and below
          if (localY - localX < 0.0) {
            opacity = 1.0;
            water = texture(waterTex, texCoordX0Ym);
            color = getWallColor(localY - 0.6);
            shadowLight = minShadowLight; // fire should not light ground
          }
        }
      }
    }
    float arrow = vectorField(base.xy, displayVectorField);

    if (arrow > 0.5) {
      fragmentColor = vec4(vec3(1., 1., 0.), 1.);
      return; // exit shader
    }

    // color.rg += vec2(arrow);
    // color.b -= arrow;
    // opacity += arrow;
    // lightIntensity += arrow;
  }


  float scatering = clamp(map_range(abs(sunAngle), 75. * deg2rad, 90. * deg2rad, 0., 1.), 0., 1.); // how red the sunlight is

  vec3 finalLight = sunColor(scatering) * lightIntensity;


  if (fract(cursor.w) > 0.5) {                                               // enable flashlight
    vec2 vecFromMouse = cursor.xy - texCoord;
    vecFromMouse.x *= texelSize.y / texelSize.x;                             // aspect ratio correction to make it a circle
                                                                             // shadowLight += max(1. / (1.+length(vecFromMouse)*5.0),0.0); // point light
    shadowLight += max(cos(min(length(vecFromMouse) * 5.0, 2.)) * 1.0, 0.0); // smooth flashlight
  }

  vec3 ambientLight = texture(ambientLightTex, texCoord).rgb;

  onLight += ambientLight * pow(1. - clamp(-texCoord.y * 15., 0., 1.), 2.5);


  finalLight += vec3(shadowLight) + onLight;

  opacity += length(emittedLight);
  opacity = clamp(opacity, 0.0, 1.0);
  fragmentColor = vec4(max(color * finalLight, 0.) + emittedLight, opacity);

  drawCursor(cursor, view); // over everything else
}
