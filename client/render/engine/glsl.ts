// Shared GLSL snippets for the engine: hashing, value noise, fbm and the procedural sky function.
// The sky function is used by the sky dome, the environment capture and the menu ocean reflection.

export const NOISE_GLSL = /* glsl */ `
float hw_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hw_hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float hw_noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hw_hash12(i);
  float b = hw_hash12(i + vec2(1.0, 0.0));
  float c = hw_hash12(i + vec2(0.0, 1.0));
  float d = hw_hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float hw_fbm(vec2 p, int octaves) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 7; i++) {
    if (i >= octaves) break;
    s += a * hw_noise2(p);
    n += a;
    p = r * p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s / n;
}
`;

/**
 * Sky radiance (linear HDR) for a unit direction. Needs NOISE_GLSL and these uniforms.
 * HW_CLOUD_OCTAVES and HW_AURORA_STEPS must be defined.
 */
export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyBelow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunDisk;
uniform float uSunSize;
uniform float uSunGlow;
uniform float uMoon;
uniform float uSkyTime;
uniform float uCloudCover;
uniform float uCloudSpeed;
uniform float uCloudScale;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform float uStars;
uniform float uAurora;
uniform float uShafts;
uniform float uHaze;
uniform float uHorizonSharp;
uniform float uSkyCurve;
uniform vec3 uSkyMid;
uniform float uSkyMidAmt;
`;

export const SKY_FN_GLSL = /* glsl */ `
float hw_stars(vec3 d, float density, float scale) {
  vec3 p = d * scale;
  vec3 c = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hw_hash13(c);
  float th = 1.0 - density;
  if (h < th) return 0.0;
  vec3 off = (vec3(hw_hash13(c + 1.37), hw_hash13(c + 2.71), hw_hash13(c + 5.13)) - 0.5) * 0.5;
  float r = length(f - off);
  float b = smoothstep(0.2, 0.0, r) * (0.35 + 0.65 * (h - th) / density);
  float tw = 0.65 + 0.35 * sin(uSkyTime * (1.3 + h * 5.0) + h * 91.0);
  return b * tw;
}

vec3 hw_aurora(vec3 d) {
  if (uAurora <= 0.0 || d.y < 0.01) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float t = uSkyTime;
  float iy = 1.0 / max(d.y, 0.06);
  for (int i = 0; i < HW_AURORA_STEPS; i++) {
    float fi = float(i) / float(HW_AURORA_STEPS);
    float h = 9.0 + fi * 14.0;
    vec2 P = d.xz * iy * h;
    // two wavy curtains above the far side of the sky
    float c1 = -46.0 + 9.0 * sin(P.x * 0.035 + t * 0.045) + 4.0 * sin(P.x * 0.093 - t * 0.07);
    float c2 = -64.0 + 12.0 * sin(P.x * 0.027 - t * 0.03 + 1.7) + 3.0 * sin(P.x * 0.11 + t * 0.05);
    float b1 = exp(-pow((P.y - c1) * 0.16, 2.0));
    float b2 = exp(-pow((P.y - c2) * 0.12, 2.0)) * 0.7;
    // vertical ray structure: fine streaks that shimmer sideways, grouped into brighter folds
    float rays = pow(hw_noise2(vec2(P.x * 0.45 + t * 0.2, fi * 0.6)), 1.6) * 1.5;
    rays *= 0.45 + 0.55 * hw_noise2(vec2(P.x * 0.06 - t * 0.04, 3.0));
    vec3 col = mix(vec3(0.12, 1.0, 0.45), vec3(0.15, 0.75, 1.0), smoothstep(0.1, 0.6, fi));
    col = mix(col, vec3(0.75, 0.25, 1.0), smoothstep(0.55, 1.0, fi));
    acc += col * (b1 + b2) * rays * (1.0 - fi * 0.75);
  }
  float fade = smoothstep(0.01, 0.2, d.y) * (1.0 - smoothstep(0.75, 1.0, d.y) * 0.6);
  return acc * (uAurora * 2.2 / float(HW_AURORA_STEPS)) * fade;
}

vec3 hw_sky(vec3 d) {
  float y = d.y;
  float up = clamp(y, 0.0, 1.0);
  float mu = dot(d, uSunDir);
  float sa = max(mu, 0.0);
  // dusk: away from the sun the horizon turns rosy violet, toward it stays warm orange
  vec3 hz = mix(uSkyHorizon, uSkyMid, uSkyMidAmt * (1.0 - pow(sa, 1.5)) * 0.85);
  // blend in a perceptual (sqrt) space so a bright horizon does not swamp a dark zenith
  vec3 col = mix(sqrt(hz), sqrt(uSkyTop), 1.0 - exp(-up * uSkyCurve));
  // dusk: a rosy band between the warm horizon and the deep blue
  col = mix(col, sqrt(uSkyMid), exp(-pow((y - 0.12) * 6.0, 2.0)) * uSkyMidAmt * 0.45);
  col *= col;
  // horizon haze band, warmer toward the sun
  float band = exp(-abs(y) * uHorizonSharp);
  col = mix(col, hz * 1.05 + uSunColor * 0.05 * pow(sa, 6.0), band * uHaze);
  // atmospheric glow around the sun / moon
  float glowK = mix(1.0, 0.35, uMoon);
  col += uSunColor * uSunGlow * glowK * (0.012 * pow(sa, 5.0) + 0.1 * pow(sa, 28.0) + 0.6 * pow(sa, 300.0));
  col += uSunColor * uSunGlow * glowK * 0.14 * pow(sa, 6.0) * exp(-max(y, 0.0) * 7.0);

  // night: stars + aurora (behind clouds)
  if (uStars > 0.0 && y > -0.02) {
    float s = hw_stars(d, 0.03, 160.0) + hw_stars(d.zxy, 0.012, 320.0) * 0.7;
    col += vec3(0.85, 0.9, 1.0) * s * uStars * smoothstep(-0.02, 0.25, y) * 1.6;
  }
  col += hw_aurora(d);

  // sun / moon disk (behind clouds)
  float theta = acos(clamp(mu, -1.0, 1.0));
  float disk = 1.0 - smoothstep(uSunSize * 0.82, uSunSize, theta);
  if (uMoon > 0.5) {
    vec3 sd = normalize(uSunDir);
    vec3 tx = normalize(cross(sd, vec3(0.0, 1.0, 0.0)));
    vec3 ty = cross(tx, sd);
    vec2 mp = vec2(dot(d, tx), dot(d, ty)) / max(sin(uSunSize), 1e-4);
    float crater = hw_noise2(mp * 3.0 + 4.0) * 0.6 + hw_noise2(mp * 7.0) * 0.4;
    float limb = sqrt(max(0.0, 1.0 - dot(mp, mp)));
    col += uSunColor * disk * uSunDisk * (0.55 + 0.45 * limb) * (0.75 + 0.35 * crater);
  } else {
    col += uSunColor * disk * uSunDisk;
  }

  // clouds: fbm on a curved plane, lit from the sun side
  if (uCloudCover > 0.0 && y > -0.03) {
    float py = max(y, 0.0) + 0.1;
    vec2 uv = d.xz / py * uCloudScale;
    vec2 wind = vec2(1.0, 0.32) * uSkyTime * uCloudSpeed;
    vec2 warp = vec2(hw_noise2(uv * 0.7 + wind * 0.5), hw_noise2(uv * 0.7 - wind * 0.4 + 5.2)) - 0.5;
    vec2 cuv = uv + warp * 0.9 + wind;
    float n = hw_fbm(cuv, HW_CLOUD_OCTAVES);
    float n2 = hw_noise2(uv * 4.3 - wind * 2.1 + 7.7);
    float shape = clamp((n * 0.85 + n2 * 0.15 - 0.5) * 2.1 + 0.5, 0.0, 1.0);
    float lo = 1.0 - uCloudCover;
    float dens = smoothstep(lo, lo + 0.2, shape);
    vec2 sdir = uSunDir.xz / (length(uSunDir.xz) + 1e-4);
    float ns = hw_fbm(cuv + sdir * 0.08, HW_CLOUD_OCTAVES);
    float lit = clamp(0.5 + (n - ns) * 9.0, 0.0, 1.0);
    // clouds far from the sun keep more of their shaded colour
    lit *= 0.35 + 0.65 * pow(sa, 2.0);
    vec3 cl = mix(uCloudDark, uCloudLit, lit);
    // thin edges glow with sun / silver lining
    float edge = dens * (1.0 - dens) * 4.0;
    cl += uSunColor * uSunGlow * edge * (0.025 + 0.9 * pow(sa, 10.0)) * mix(1.0, 0.4, uMoon);
    cl = mix(cl, cl * 0.8 + uSkyHorizon * 0.2, (1.0 - up) * 0.6);
    float fade = smoothstep(-0.03, 0.14, y);
    col = mix(col, cl, dens * fade * 0.96);
    // light shafts: angular streaks around the sun, blocked by cloud mass near the sun
    if (uShafts > 0.0) {
      vec3 sd = normalize(uSunDir);
      vec3 tx = normalize(cross(sd, vec3(0.0, 1.0, 0.0)));
      vec3 ty = cross(tx, sd);
      float ang = atan(dot(d, ty), dot(d, tx));
      float rays = hw_noise2(vec2(ang * 5.0, uSkyTime * 0.03)) * 0.6 + hw_noise2(vec2(ang * 13.0 + 3.0, uSkyTime * 0.05)) * 0.4;
      float sh = pow(sa, 30.0) * smoothstep(0.4, 0.95, rays) * (1.0 - dens * 0.9);
      col += uSunColor * sh * uShafts * smoothstep(-0.05, 0.05, y);
    }
  }

  // below the horizon the dome fades into fog (in play) or ground (environment capture)
  float below = 1.0 - smoothstep(-0.12, 0.015, y);
  col = mix(col, uSkyBelow, below);
  return max(col, vec3(0.0));
}
`;
