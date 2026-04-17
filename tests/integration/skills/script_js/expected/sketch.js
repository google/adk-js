/* eslint-disable */
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ephemeral Entanglement: A generative art exploration
// Meticulously crafted algorithmic expression

let particles = [];
let params = {
  count: 400,
  radius: 70,
  noiseScale: 0.02, // Mapped from UI 1-100 to 0.001-0.1
  speedFactor: 1.5,
  hueBase: 0,
};

let currentSeed;

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSB, 360, 100, 100, 1);
  background(0);

  // Setup UI listeners
  setupUI();

  // Initialize system
  initSystem();
}

function initSystem() {
  background(0);
  currentSeed = random(10000);
  noiseSeed(currentSeed);
  randomSeed(currentSeed);

  params.hueBase = random(360);

  particles = [];
  for (let i = 0; i < params.count; i++) {
    particles.push(new Particle());
  }
}

function setupUI() {
  const countSlider = document.getElementById('particleCount');
  const radiusSlider = document.getElementById('connectionRadius');
  const noiseSlider = document.getElementById('noiseScale');
  const resetBtn = document.getElementById('resetBtn');

  countSlider.addEventListener('input', (e) => {
    let newCount = parseInt(e.target.value);
    if (newCount > particles.length) {
      for (let i = particles.length; i < newCount; i++) {
        particles.push(new Particle());
      }
    } else if (newCount < particles.length) {
      particles.splice(newCount);
    }
    params.count = newCount;
  });

  radiusSlider.addEventListener('input', (e) => {
    params.radius = parseInt(e.target.value);
  });

  noiseSlider.addEventListener('input', (e) => {
    params.noiseScale = map(parseInt(e.target.value), 1, 100, 0.001, 0.1);
  });

  resetBtn.addEventListener('click', initSystem);
}

function draw() {
  // Fade background slowly to leave trails
  background(0, 0, 0, 0.05);

  // Update and display particles
  for (let i = 0; i < particles.length; i++) {
    particles[i].update();
    particles[i].display();
  }

  // Draw ephemeral connections
  drawConnections();

  // Slowly evolve base hue
  params.hueBase = (params.hueBase + 0.1) % 360;
}

function drawConnections() {
  let rSq = params.radius * params.radius;

  // Optimize with spatial hashing in a more complex version,
  // but nested loop is fine for < 1000 particles
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      let p1 = particles[i];
      let p2 = particles[j];

      let dx = p1.pos.x - p2.pos.x;
      let dy = p1.pos.y - p2.pos.y;
      let distSq = dx * dx + dy * dy;

      if (distSq < rSq) {
        let distRatio = 1 - distSq / rSq;
        // The closer they are, the stronger the bond and opacity
        let opacity = map(distRatio, 0, 1, 0, 0.5);

        // Color based on particle velocity and base hue
        let avgVel = (p1.vel.mag() + p2.vel.mag()) / 2;
        let hueOffset = map(avgVel, 0, 3, -30, 30);
        let cHue = (params.hueBase + hueOffset + 360) % 360;

        strokeWeight(distRatio * 1.5);
        stroke(cHue, 80, 100, opacity);
        line(p1.pos.x, p1.pos.y, p2.pos.x, p2.pos.y);

        // Apply slight attraction when connected
        let force = createVector(dx, dy)
          .normalize()
          .mult(0.01 * distRatio);
        p1.vel.sub(force);
        p2.vel.add(force);
      }
    }
  }
}

class Particle {
  constructor() {
    this.pos = createVector(random(width), random(height));
    this.vel = createVector(random(-1, 1), random(-1, 1));
    this.acc = createVector(0, 0);
    this.maxSpeed = random(1, 3);
    // Individual noise offset for organic variation
    this.zOffset = random(1000);
  }

  update() {
    // Calculate flow field force based on Perlin noise
    let angle =
      noise(
        this.pos.x * params.noiseScale,
        this.pos.y * params.noiseScale,
        frameCount * 0.005 + this.zOffset,
      ) *
      TWO_PI *
      4; // Multiply for more turbulent flow

    let flowForce = p5.Vector.fromAngle(angle);
    flowForce.mult(0.1);

    this.acc.add(flowForce);

    this.vel.add(this.acc);
    this.vel.limit(this.maxSpeed * params.speedFactor);
    this.pos.add(this.vel);

    this.acc.mult(0); // Reset acceleration

    this.edges();
  }

  display() {
    noStroke();
    fill(255, 0.5); // Very faint core
    circle(this.pos.x, this.pos.y, 2);
  }

  edges() {
    // Wrap around edges to maintain particle density
    if (this.pos.x > width) this.pos.x = 0;
    if (this.pos.x < 0) this.pos.x = width;
    if (this.pos.y > height) this.pos.y = 0;
    if (this.pos.y < 0) this.pos.y = height;
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  background(0);
}
