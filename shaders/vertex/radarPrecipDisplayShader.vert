#version 300 es
precision highp float;

layout(location = 0) in vec2 dropPosition;
layout(location = 1) in vec2 mass;
layout(location = 2) in float density;

out vec2 mass_out;
out float density_out;

uniform vec2 aspectRatios; // sim   canvas
uniform vec3 view;         // Xpos  Ypos    Zoom

void main()
{
    vec2 outpos = dropPosition;

    outpos.x += view.x;
    outpos.y += view.y * aspectRatios[0];
    outpos *= view[2];
    outpos.y *= aspectRatios[1] / aspectRatios[0];

    gl_Position = vec4(outpos, 0.0, 1.0);

    // Larger footprint than normal particle display to simulate radar beam width
    gl_PointSize = view[2] * 10.0 / aspectRatios[0];

    mass_out    = mass;
    density_out = density;
}
