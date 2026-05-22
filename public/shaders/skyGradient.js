export const vertexShader = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;

varying float vGradientT;

void main() {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    vGradientT = uv.y;
}
`;

export const fragmentShader = `
precision highp float;

uniform vec3 topColor;
uniform vec3 midColor;
uniform vec3 horizonColor;
uniform float midPoint;
uniform float exponent;

varying float vGradientT;

void main() {
    float y = clamp(vGradientT, 0.0, 1.0);
    y = pow(y, exponent);

    vec3 color;
    if (y < midPoint) {
        float t = smoothstep(0.0, midPoint, y);
        color = mix(horizonColor, midColor, t);
    } else {
        float t = smoothstep(midPoint, 1.0, y);
        color = mix(midColor, topColor, t);
    }

    gl_FragColor = vec4(color, 1.0);
}
`;
