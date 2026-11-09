'use strict';
const cp = require('node:child_process');
const os = require('node:os');

/**
 * Detects available hardware and OS telemetry providers.
 * Returns provider capabilities, supported fields, units, and unavailable fields.
 */
function detectTelemetryProvider() {
  // 1. Check NVIDIA via nvidia-smi
  try {
    const raw = cp.execFileSync('nvidia-smi', [
      '--query-gpu=name,driver_version,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.current.graphics,clocks.current.memory,pstate',
      '--format=csv,noheader,nounits'
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 3000
    });

    if (raw && raw.trim()) {
      return {
        provider: 'nvidia-smi',
        displayName: 'NVIDIA System Management Interface (nvidia-smi)',
        isAvailable: true,
        available: true,
        device: raw.split(',')[0]?.trim() || 'NVIDIA GPU',
        driver: raw.split(',')[1]?.trim() || 'NVIDIA Driver',
        supportedFields: [
          'gpuUtilization',
          'encoderUtilization',
          'decoderUtilization',
          'memoryUsedMb',
          'memoryTotalMb',
          'temperatureC',
          'powerWatts',
          'graphicsClockMhz',
          'memoryClockMhz',
          'pstate',
          'throttling'
        ],
        units: {
          gpuUtilization: '%',
          encoderUtilization: '%',
          decoderUtilization: '%',
          memoryUsedMb: 'MB',
          memoryTotalMb: 'MB',
          temperatureC: '°C',
          powerWatts: 'W',
          graphicsClockMhz: 'MHz',
          memoryClockMhz: 'MHz'
        },
        unavailableFields: []
      };
    }
  } catch {}

  // 2. Check Windows GPU Engine Performance Counters (Intel Arc / QSV / AMD on Windows)
  if (process.platform === 'win32') {
    try {
      const typeperfCheck = cp.execFileSync('typeperf', ['-q', 'GPU Engine'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 4000
      });

      if (typeperfCheck && typeperfCheck.includes('GPU Engine')) {
        return {
          provider: 'windows-pdh',
          displayName: 'Windows Performance Data Helper (WDDM GPU Engine)',
          isAvailable: true,
          available: true,
          device: 'Windows WDDM GPU (DirectX / QSV / Intel Arc)',
          driver: 'Windows Graphics Driver',
          supportedFields: [
            'gpuUtilization',
            'encoderUtilization',
            'hostCpuUtilization',
            'hostMemoryUsedMb',
            'hostMemoryTotalMb'
          ],
          units: {
            gpuUtilization: '%',
            encoderUtilization: '%',
            hostCpuUtilization: '%',
            hostMemoryUsedMb: 'MB',
            hostMemoryTotalMb: 'MB'
          },
          unavailableFields: [
            'temperatureC',
            'powerWatts',
            'graphicsClockMhz',
            'memoryClockMhz',
            'throttling'
          ],
          limitations: 'Windows Performance Counters expose engine utilization and memory, but do not expose direct hardware temperature or power sensors without vendor-specific kernel drivers.'
        };
      }
    } catch {}
  }

  // 3. Fallback to host CPU and OS Memory
  return {
    provider: 'system',
    displayName: 'Host System (CPU / RAM)',
    isAvailable: true,
    available: true,
    device: `${os.cpus()[0]?.model || 'Host CPU'} (${os.cpus().length} cores)`,
    driver: os.type(),
    supportedFields: [
      'hostCpuUtilization',
      'hostMemoryUsedMb',
      'hostMemoryTotalMb'
    ],
    units: {
      hostCpuUtilization: '%',
      hostMemoryUsedMb: 'MB',
      hostMemoryTotalMb: 'MB'
    },
    unavailableFields: [
      'gpuUtilization',
      'encoderUtilization',
      'decoderUtilization',
      'memoryUsedMb',
      'memoryTotalMb',
      'temperatureC',
      'powerWatts',
      'graphicsClockMhz',
      'memoryClockMhz',
      'throttling'
    ],
    limitations: 'No dedicated GPU telemetry provider detected; collecting host CPU and system memory metrics.'
  };
}

/**
 * Samples current hardware state once based on the resolved provider.
 */
function sampleHardwareState(providerInfo, prevCpuInfo = null) {
  const timestampMs = Date.now();
  const sample = {
    timestampMs,
    metrics: {}
  };

  // Host CPU & Memory baseline calculation
  const totalMem = Math.round(os.totalmem() / (1024 * 1024));
  const freeMem = Math.round(os.freemem() / (1024 * 1024));
  sample.metrics.hostMemoryTotalMb = totalMem;
  sample.metrics.hostMemoryUsedMb = totalMem - freeMem;

  const cpus = os.cpus();
  let totalCpuUser = 0;
  let totalCpuSystem = 0;
  let totalCpuIdle = 0;
  for (const c of cpus) {
    totalCpuUser += c.times.user;
    totalCpuSystem += c.times.sys;
    totalCpuIdle += c.times.idle;
  }
  const currentCpuInfo = { user: totalCpuUser, sys: totalCpuSystem, idle: totalCpuIdle };

  if (prevCpuInfo) {
    const deltaUser = currentCpuInfo.user - prevCpuInfo.user;
    const deltaSys = currentCpuInfo.sys - prevCpuInfo.sys;
    const deltaIdle = currentCpuInfo.idle - prevCpuInfo.idle;
    const deltaTotal = deltaUser + deltaSys + deltaIdle;
    if (deltaTotal > 0) {
      sample.metrics.hostCpuUtilization = Math.round(((deltaUser + deltaSys) / deltaTotal) * 1000) / 10;
    }
  }

  if (providerInfo.provider === 'nvidia-smi') {
    try {
      const raw = cp.execFileSync('nvidia-smi', [
        '--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.current.graphics,clocks.current.memory,pstate',
        '--format=csv,noheader,nounits'
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 2000
      });

      const parts = raw.trim().split(',').map(s => s.trim());
      if (parts.length >= 10) {
        sample.metrics.gpuUtilization = parseFloat(parts[0]) || 0;
        sample.metrics.encoderUtilization = parseFloat(parts[1]) || 0;
        sample.metrics.decoderUtilization = parseFloat(parts[2]) || 0;
        sample.metrics.memoryUsedMb = parseFloat(parts[3]) || 0;
        sample.metrics.memoryTotalMb = parseFloat(parts[4]) || 0;
        sample.metrics.temperatureC = parseFloat(parts[5]) || 0;
        sample.metrics.powerWatts = parseFloat(parts[6]) || 0;
        sample.metrics.graphicsClockMhz = parseFloat(parts[7]) || 0;
        sample.metrics.memoryClockMhz = parseFloat(parts[8]) || 0;
        sample.metrics.pstate = parts[9] || 'P0';
      }

      // Query throttling status if exposed
      try {
        const throttleRaw = cp.execFileSync('nvidia-smi', [
          '--query-gpu=clocks_throttle_reasons.active',
          '--format=csv,noheader,nounits'
        ], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2000
        });
        const throttleVal = throttleRaw.trim();
        sample.metrics.throttling = throttleVal && throttleVal !== '0x0000000000000000' && throttleVal !== 'None'
          ? throttleVal
          : 'None';
      } catch {
        sample.metrics.throttling = 'None';
      }
    } catch {}
  } else if (providerInfo.provider === 'windows-pdh') {
    // Windows Performance Counters for GPU Engine VideoEncode
    try {
      const out = cp.execFileSync('typeperf', [
        '\\GPU Engine(*engtype_VideoEncode*)\\Utilization Percentage',
        '-sc', '1'
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 2500
      });

      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length >= 3) {
        const values = lines[2].split(',').map(s => parseFloat(s.replace(/"/g, ''))).filter(n => !isNaN(n));
        const maxEncode = values.length ? Math.max(...values) : 0;
        sample.metrics.encoderUtilization = Math.round(maxEncode * 10) / 10;
        sample.metrics.gpuUtilization = sample.metrics.encoderUtilization;
      }
    } catch {}
  }

  return { sample, currentCpuInfo };
}

/**
 * Calculates statistical summary (mean, min, max, p95) for a numeric telemetry metric.
 */
function calculateMetricSummary(samples, metricKey) {
  const values = samples
    .map(s => s.metrics?.[metricKey])
    .filter(v => typeof v === 'number' && !isNaN(v));

  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = Math.round((sum / sorted.length) * 100) / 100;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));

  return {
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[p95Idx]
  };
}

/**
 * Telemetry Collector class that manages periodic sampling, phase labeling,
 * and clean isolation between encoding and post-encode quality analysis.
 */
class TelemetryCollector {
  constructor(options = {}) {
    this.intervalMs = Math.max(200, options.intervalMs || 500);
    this.providerInfo = options.providerInfo || detectTelemetryProvider();
    this.signal = options.signal || null;
    this.samples = [];
    this.activePhase = 'idle_baseline';
    this.activeContext = {};
    this.timer = null;
    this.isRunning = false;
    this.prevCpuInfo = null;
    this.startTimeMs = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTimeMs = Date.now();

    // Initial baseline sample
    const { sample, currentCpuInfo } = sampleHardwareState(this.providerInfo, this.prevCpuInfo);
    this.prevCpuInfo = currentCpuInfo;
    sample.phase = this.activePhase;
    sample.context = { ...this.activeContext };
    sample.elapsedSec = 0;
    this.samples.push(sample);

    this.timer = setInterval(() => {
      if (!this.isRunning) return;
      if (this.signal?.aborted) {
        this.stop();
        return;
      }

      const { sample: s, currentCpuInfo: c } = sampleHardwareState(this.providerInfo, this.prevCpuInfo);
      this.prevCpuInfo = c;
      s.phase = this.activePhase;
      s.context = { ...this.activeContext };
      s.elapsedSec = Math.round(((Date.now() - this.startTimeMs) / 1000) * 10) / 10;
      this.samples.push(s);
    }, this.intervalMs);

    // Ensure timer does not prevent process exit
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  setPhase(phase, context = {}) {
    this.activePhase = phase;
    this.activeContext = context;
  }

  get phase() {
    return this.activePhase;
  }

  recordSample(metrics = {}) {
    const s = {
      timestampMs: Date.now(),
      phase: this.activePhase,
      context: { ...this.activeContext },
      elapsedSec: this.startTimeMs ? Math.round(((Date.now() - this.startTimeMs) / 1000) * 10) / 10 : 0,
      metrics
    };
    this.samples.push(s);
    return s;
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Generates summary statistics strictly isolating transcoding execution
   * from warm-up and post-encode quality analysis.
   */
  getSummary() {
    const encodingSamples = this.samples.filter(s => s.phase === 'encoding');
    const qualitySamples = this.samples.filter(s => s.phase === 'quality_analysis');
    const baselineSamples = this.samples.filter(s => s.phase === 'idle_baseline');

    const encodingMetrics = {};
    const relevantKeys = [
      'gpuUtilization',
      'encoderUtilization',
      'decoderUtilization',
      'memoryUsedMb',
      'temperatureC',
      'powerWatts',
      'graphicsClockMhz',
      'memoryClockMhz',
      'hostCpuUtilization',
      'hostMemoryUsedMb'
    ];

    for (const key of relevantKeys) {
      const stat = calculateMetricSummary(encodingSamples, key);
      if (stat) {
        encodingMetrics[key] = {
          ...stat,
          unit: this.providerInfo.units?.[key] || ''
        };
      }
    }

    const qualityMetrics = {};
    for (const key of relevantKeys) {
      const stat = calculateMetricSummary(qualitySamples, key);
      if (stat) {
        qualityMetrics[key] = {
          ...stat,
          unit: this.providerInfo.units?.[key] || ''
        };
      }
    }

    // Thermal delta during encoding
    const temps = encodingSamples
      .map(s => s.metrics?.temperatureC)
      .filter(v => typeof v === 'number' && !isNaN(v));
    const thermalClimb = temps.length >= 2 ? Math.round((temps[temps.length - 1] - temps[0]) * 10) / 10 : 0;

    // Active throttling during encoding
    const activeReasons = [];
    for (const s of encodingSamples) {
      if (typeof s.metrics?.throttling === 'string' && s.metrics.throttling !== 'None') {
        activeReasons.push(s.metrics.throttling);
      }
      if (Array.isArray(s.metrics?.throttleReasons)) {
        for (const r of s.metrics.throttleReasons) {
          if (r && r !== 'None') activeReasons.push(r);
        }
      }
    }
    const throttlingDetected = encodingSamples.some(s => Boolean(s.metrics?.throttling));
    if (throttlingDetected && activeReasons.length === 0) {
      activeReasons.push('Active');
    }

    return {
      provider: this.providerInfo.provider,
      device: this.providerInfo.device,
      driver: this.providerInfo.driver,
      intervalMs: this.intervalMs,
      totalSamples: this.samples.length,
      encodingSampleCount: encodingSamples.length,
      qualitySampleCount: qualitySamples.length,
      encoding: {
        sampleCount: encodingSamples.length,
        metrics: encodingMetrics,
        thermalClimbC: thermalClimb,
        throttlingDetected,
        activeThrottleReasons: [...new Set(activeReasons)]
      },
      qualityAnalysis: {
        sampleCount: qualitySamples.length,
        metrics: qualityMetrics
      },
      supportedFields: this.providerInfo.supportedFields,
      unavailableFields: this.providerInfo.unavailableFields,
      timeline: this.samples
    };
  }
}

module.exports = {
  detectTelemetryProvider,
  sampleHardwareState,
  calculateMetricSummary,
  TelemetryCollector
};
