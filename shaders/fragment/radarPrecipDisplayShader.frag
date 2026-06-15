#version 300 es
precision highp float;

in vec2 mass_out;
in float density_out;

out vec4 fragmentColor;

#define WATER 0
#define ICE   1

// 1 / ln(10)  — converts natural log to log base 10
const float INV_LN10 = 0.43429;

// NWS WSR-88D (NEXRAD) base reflectivity colour table — smoothly interpolated
vec3 radarColor(float dbz) {
    if (dbz < 5.0) return vec3(0.0);

    dbz = min(dbz, 70.0);

    vec3 c[14];
    c[0]  = vec3(0.004, 0.929, 0.929); // #01EDEE   5 dBZ  light cyan
    c[1]  = vec3(0.004, 0.624, 0.957); // #019FE0  10 dBZ  medium blue
    c[2]  = vec3(0.012, 0.000, 0.957); // #0300F4  15 dBZ  dark blue
    c[3]  = vec3(0.008, 0.992, 0.008); // #02FD02  20 dBZ  bright green
    c[4]  = vec3(0.004, 0.773, 0.004); // #01C501  25 dBZ  medium green
    c[5]  = vec3(0.000, 0.557, 0.000); // #008E00  30 dBZ  dark green
    c[6]  = vec3(0.992, 0.973, 0.008); // #FDF802  35 dBZ  yellow
    c[7]  = vec3(0.898, 0.737, 0.000); // #E5BC00  40 dBZ  gold
    c[8]  = vec3(0.992, 0.584, 0.000); // #FD9500  45 dBZ  orange
    c[9]  = vec3(0.992, 0.000, 0.000); // #FD0000  50 dBZ  red
    c[10] = vec3(0.831, 0.000, 0.000); // #D40000  55 dBZ  dark red
    c[11] = vec3(0.973, 0.000, 0.992); // #F800FD  60 dBZ  magenta
    c[12] = vec3(0.596, 0.329, 0.776); // #9854C6  65 dBZ  purple
    c[13] = vec3(1.000, 1.000, 1.000); //          70 dBZ  white

    float t = (dbz - 5.0) / 5.0;
    int   i = int(t);
    float f = t - float(i);

    return mix(c[i], c[min(i + 1, 13)], f);
}

void main()
{
    if (mass_out[WATER] < 0.0)
        discard;

    float totalMass = mass_out[WATER] + mass_out[ICE];

    // Diameter in mm — matches app.js: diameterMm = 2.0 * pow(totalMass, 1/3)
    float diamMm = 2.0 * pow(max(totalMass, 0.001), 0.33333);

    // Radar reflectivity factor Z = D^6  →  dBZ = 60 * log10(D)
    float dbz = 60.0 * log(diamMm) * INV_LN10;

    // Snow: lower dielectric factor (~0.2 vs 0.93 for water), ≈ −7 dBZ correction
    if (mass_out[ICE] > 0.0 && mass_out[WATER] < 0.01 && density_out < 1.0)
        dbz -= 7.0;

    // Hail: dense hard ice returns stronger signal, +8 dBZ boost
    if (mass_out[ICE] > 0.0 && mass_out[WATER] < 0.01 && density_out >= 1.0)
        dbz += 8.0;

    if (dbz < 5.0)
        discard;

    // Circular point shape with a soft edge
    vec2 coord = gl_PointCoord - vec2(0.5);
    float r = length(coord);
    if (r > 0.5)
        discard;

    float alpha = 1.0 - smoothstep(0.35, 0.50, r);

    fragmentColor = vec4(radarColor(dbz), alpha);
}
