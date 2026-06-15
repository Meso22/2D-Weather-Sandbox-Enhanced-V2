#version 300 es
precision highp float;
precision highp isampler2D;

in vec2 texCoord;
in vec2 fragCoord;

uniform sampler2D waterTex;
uniform isampler2D wallTex;

uniform vec2 resolution;
uniform vec2 texelSize;
uniform float dryLapse;

uniform vec3 view;
uniform vec4 cursor;
uniform float radarPixelSize;
uniform float isOverlay;
uniform float overlayOpacity;

out vec4 fragmentColor;

#include "common.glsl"
#include "commonDisplay.glsl"

// NEXRAD standard reflectivity color scale
// NWS WSR-88D (NEXRAD) base reflectivity colour table — smoothly interpolated
vec3 radarColor(float dbz) {
    if (dbz < 5.0) return vec3(0.0);

    dbz = min(dbz, 70.0);

    // 14 stops spaced every 5 dBZ from 5 → 70
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
    // Snap to coarse grid — simulates discrete radar range-gate bins
    vec2 pxFragCoord = floor(fragCoord / radarPixelSize) * radarPixelSize + radarPixelSize * 0.5;
    vec2 pxTexCoord  = pxFragCoord * texelSize;

    ivec4 wall = texture(wallTex, pxTexCoord);

    // Dark radar background (transparent when used as overlay)
    if (isOverlay > 0.5) {
        fragmentColor = vec4(0.0, 0.0, 0.0, 0.0);
    } else {
        fragmentColor = vec4(0.05, 0.06, 0.08, 1.0);
    }

    if (wall[DISTANCE] == 0) {
        if (isOverlay < 0.5) {
            if (wall[TYPE] == WALLTYPE_WATER)
                fragmentColor = vec4(0.07, 0.09, 0.14, 1.0);
            else
                fragmentColor = vec4(0.18, 0.18, 0.18, 1.0);
        }
        return;
    }

    // Sample at bin centre — bilinear interp would defeat the pixelation
    vec4 water = texture(waterTex, pxTexCoord);

    float precipWater = water[PRECIPITATION];

    // Only precipitation-sized particles register on radar
    float dbz = 10.0 * log(precipWater * 5000.0 + 1.0) / log(10.0);

    if (dbz >= 5.0) {
        float alpha = isOverlay > 0.5 ? overlayOpacity : 1.0;
        fragmentColor = vec4(radarColor(dbz), alpha);
    }

    drawCursor(cursor, view);
}
