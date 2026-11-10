'use strict';
const cp = require('node:child_process');
const os = require('node:os');

/**
 * Safely parses a telemetry metric string or number into a valid float or null.
 * Never substitutes zero for unsupported, N/A, or missing values.
 */
function parseMetricNumber(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return isNaN(val) ? null : val;
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t || t === 'N/A' || t === '[Not Supported]' || t === 'None' || t === 'unknown' || t === '[Unknown]') {
      return null;
    }
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Decodes NVML / nvidia-smi clocks_throttle_reasons.active values.
 * Strictly distinguishes:
 * - Confirmed active hardware throttle reasons (power cap, thermal slowdown, HW slowdown)
 * - Confirmed absence of throttling (None, Idle 0x01, Applications Clocks 0x02, Display Clock 0x100)
 * - Unsupported or unavailable throttle sensors
 */
function decodeNvidiaThrottleReasons(raw) {
  if (raw === null || raw === undefined) {
    return { isSupported: false, isThrottling: null, reasons: [] };
  }

  const str = String(raw).trim();
  if (!str || str === 'N/A' || str === '[Not Supported]' || str === '[Unknown]') {
    return { isSupported: false, isThrottling: null, reasons: [] };
  }

  if (str.toLowerCase() === 'none' || str === '0x0000000000000000' || str === '0x0') {
    return { isSupported: true, isThrottling: false, reasons: [] };
  }

  // Hexadecimal bitmask parsing (NVML specification)
  if (str.startsWith('0x') || str.startsWith('0X')) {
    try {
      const mask = BigInt(str);
      const reasons = [];

      // NVML bit definitions:
      // 0x0000000000000001: gpu_idle (NOT throttling; clock reduction while GPU is idle)
      // 0x0000000000000002: applications_clocks_setting (NOT throttling; target app clocks set)
      // 0x0000000000000004: sw_power_cap (Active throttle: SW power capping)
      // 0x0000000000000008: hw_slowdown (Active throttle: HW slowdown signal asserted)
      // 0x0000000000000010: sync_boost (NOT throttling; clock sync)
      // 0x0000000000000020: sw_thermal_slowdown (Active throttle: SW thermal slowdown)
      // 0x0000000000000040: hw_thermal_slowdown (Active throttle: HW thermal slowdown)
      // 0x0000000000000080: hw_power_brake (Active throttle: HW power brake / external power drop)
      // 0x0000000000000100: display_clocks_setting (NOT throttling; display clock requirement)

      if ((mask & 0x0000000000000004n) !== 0n) reasons.push('sw_power_cap');
      if ((mask & 0x0000000000000008n) !== 0n) reasons.push('hw_slowdown');
      if ((mask & 0x0000000000000020n) !== 0n) reasons.push('sw_thermal_slowdown');
      if ((mask & 0x0000000000000040n) !== 0n) reasons.push('hw_thermal_slowdown');
      if ((mask & 0x0000000000000080n) !== 0n) reasons.push('hw_power_brake');

      return {
        isSupported: true,
        isThrottling: reasons.length > 0,
        reasons
      };
    } catch {}
  }

  // Text-based throttle reason parsing
  const reasons = [];
  if (/sw_power_cap|power_cap/i.test(str)) reasons.push('sw_power_cap');
  if (/hw_thermal|thermal_slowdown/i.test(str)) reasons.push('hw_thermal_slowdown');
  if (/sw_thermal/i.test(str)) reasons.push('sw_thermal_slowdown');
  if (/hw_slowdown/i.test(str)) reasons.push('hw_slowdown');
  if (/hw_power_brake|power_brake/i.test(str)) reasons.push('hw_power_brake');

  if (reasons.length === 0) {
    if (/idle|none|not_active|idle_clock/i.test(str)) {
      return { isSupported: true, isThrottling: false, reasons: [] };
    }
    if (/active|slowdown|throttl/i.test(str)) {
      reasons.push('active_throttle');
    }
  }

  return {
    isSupported: true,
    isThrottling: reasons.length > 0,
    reasons
  };
}

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
        deviceAttribution: 'verified',
        throttlingSupported: true,
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
          deviceAttribution: 'unverified',
          throttlingSupported: false,
          supportedFields: [
            'encoderUtilization',
            'hostCpuUtilization',
            'hostMemoryUsedMb',
            'hostMemoryTotalMb'
          ],
          units: {
            encoderUtilization: '%',
            hostCpuUtilization: '%',
            hostMemoryUsedMb: 'MB',
            hostMemoryTotalMb: 'MB'
          },
          unavailableFields: [
            'gpuUtilization',
            'temperatureC',
            'powerWatts',
            'graphicsClockMhz',
            'memoryClockMhz',
            'throttling'
          ],
          limitations: 'Windows Performance Counters sample OS-level VideoEncode engine utilization across active processes. Device attribution cannot be guaranteed on multi-GPU systems, and direct GPU temperature, power, and clock sensors are not exposed by WDDM counters.'
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
    deviceAttribution: 'verified',
    throttlingSupported: false,
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
 * Calculates host CPU and memory metrics.
 */
function sampleHostCpuAndMemory(prevCpuInfo = null) {
  const totalMem = Math.round(os.totalmem() / (1024 * 1024));
  const freeMem = Math.round(os.freemem() / (1024 * 1024));
  const metrics = {
    hostMemoryTotalMb: totalMem,
    hostMemoryUsedMb: totalMem - freeMem,
    hostCpuUtilization: null
  };

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
      metrics.hostCpuUtilization = Math.round(((deltaUser + deltaSys) / deltaTotal) * 1000) / 10;
    }
  }

  return { metrics, currentCpuInfo };
}

/**
 * Samples current hardware state synchronously based on the resolved provider.
 */
function sampleHardwareState(providerInfo, prevCpuInfo = null) {
  const timestampMs = Date.now();
  const { metrics: hostMetrics, currentCpuInfo } = sampleHostCpuAndMemory(prevCpuInfo);
  const sample = {
    timestampMs,
    metrics: { ...hostMetrics }
  };

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
        sample.metrics.gpuUtilization = parseMetricNumber(parts[0]);
        sample.metrics.encoderUtilization = parseMetricNumber(parts[1]);
        sample.metrics.decoderUtilization = parseMetricNumber(parts[2]);
        sample.metrics.memoryUsedMb = parseMetricNumber(parts[3]);
        sample.metrics.memoryTotalMb = parseMetricNumber(parts[4]);
        sample.metrics.temperatureC = parseMetricNumber(parts[5]);
        sample.metrics.powerWatts = parseMetricNumber(parts[6]);
        sample.metrics.graphicsClockMhz = parseMetricNumber(parts[7]);
        sample.metrics.memoryClockMhz = parseMetricNumber(parts[8]);
        sample.metrics.pstate = parts[9] && parts[9] !== 'N/A' ? parts[9] : null;
      }

      // Query throttling status
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
        const decoded = decodeNvidiaThrottleReasons(throttleRaw.trim());
        sample.metrics.throttlingSupported = decoded.isSupported;
        sample.metrics.throttlingDetected = decoded.isThrottling;
        sample.metrics.activeThrottleReasons = decoded.reasons;
        sample.metrics.throttling = decoded.isThrottling ? decoded.reasons.join(', ') : (decoded.isSupported ? 'None' : null);
      } catch {
        sample.metrics.throttlingSupported = true;
        sample.metrics.throttlingDetected = null;
        sample.metrics.activeThrottleReasons = [];
        sample.metrics.throttling = null;
      }
    } catch {}
  } else if (providerInfo.provider === 'windows-pdh') {
    sample.metrics.throttlingSupported = false;
    sample.metrics.throttlingDetected = null;
    sample.metrics.activeThrottleReasons = [];
    sample.metrics.throttling = null;
    sample.metrics.gpuUtilization = null; // Do not equate encoder to total GPU

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
      }
    } catch {}
  } else {
    sample.metrics.throttlingSupported = false;
    sample.metrics.throttlingDetected = null;
    sample.metrics.activeThrottleReasons = [];
    sample.metrics.throttling = null;
  }

  return { sample, currentCpuInfo };
}

/**
 * Executes a command asynchronously and returns stdout string, or rejects on error/timeout.
 */
function execFileAsync(cmd, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/**
 * Samples hardware state asynchronously without blocking Node event loop.
 */
async function sampleHardwareStateAsync(providerInfo, prevCpuInfo = null) {
  const timestampMs = Date.now();
  const { metrics: hostMetrics, currentCpuInfo } = sampleHostCpuAndMemory(prevCpuInfo);
  const sample = {
    timestampMs,
    metrics: { ...hostMetrics }
  };

  if (providerInfo.provider === 'nvidia-smi') {
    try {
      const [rawMetrics, rawThrottle] = await Promise.all([
        execFileAsync('nvidia-smi', [
          '--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.current.graphics,clocks.current.memory,pstate',
          '--format=csv,noheader,nounits'
        ], 2000).catch(() => null),
        execFileAsync('nvidia-smi', [
          '--query-gpu=clocks_throttle_reasons.active',
          '--format=csv,noheader,nounits'
        ], 2000).catch(() => null)
      ]);

      if (rawMetrics) {
        const parts = rawMetrics.trim().split(',').map(s => s.trim());
        if (parts.length >= 10) {
          sample.metrics.gpuUtilization = parseMetricNumber(parts[0]);
          sample.metrics.encoderUtilization = parseMetricNumber(parts[1]);
          sample.metrics.decoderUtilization = parseMetricNumber(parts[2]);
          sample.metrics.memoryUsedMb = parseMetricNumber(parts[3]);
          sample.metrics.memoryTotalMb = parseMetricNumber(parts[4]);
          sample.metrics.temperatureC = parseMetricNumber(parts[5]);
          sample.metrics.powerWatts = parseMetricNumber(parts[6]);
          sample.metrics.graphicsClockMhz = parseMetricNumber(parts[7]);
          sample.metrics.memoryClockMhz = parseMetricNumber(parts[8]);
          sample.metrics.pstate = parts[9] && parts[9] !== 'N/A' ? parts[9] : null;
        }
      }

      if (rawThrottle !== null) {
        const decoded = decodeNvidiaThrottleReasons(rawThrottle.trim());
        sample.metrics.throttlingSupported = decoded.isSupported;
        sample.metrics.throttlingDetected = decoded.isThrottling;
        sample.metrics.activeThrottleReasons = decoded.reasons;
        sample.metrics.throttling = decoded.isThrottling ? decoded.reasons.join(', ') : (decoded.isSupported ? 'None' : null);
      } else {
        sample.metrics.throttlingSupported = true;
        sample.metrics.throttlingDetected = null;
        sample.metrics.activeThrottleReasons = [];
        sample.metrics.throttling = null;
      }
    } catch {}
  } else if (providerInfo.provider === 'windows-pdh') {
    sample.metrics.throttlingSupported = false;
    sample.metrics.throttlingDetected = null;
    sample.metrics.activeThrottleReasons = [];
    sample.metrics.throttling = null;
    sample.metrics.gpuUtilization = null; // Do not equate encoder to total GPU

    try {
      const out = await execFileAsync('typeperf', [
        '\\GPU Engine(*engtype_VideoEncode*)\\Utilization Percentage',
        '-sc', '1'
      ], 2500).catch(() => null);

      if (out) {
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length >= 3) {
          const values = lines[2].split(',').map(s => parseFloat(s.replace(/"/g, ''))).filter(n => !isNaN(n));
          const maxEncode = values.length ? Math.max(...values) : 0;
          sample.metrics.encoderUtilization = Math.round(maxEncode * 10) / 10;
        }
      }
    } catch {}
  } else {
    sample.metrics.throttlingSupported = false;
    sample.metrics.throttlingDetected = null;
    sample.metrics.activeThrottleReasons = [];
    sample.metrics.throttling = null;
  }

  return { sample, currentCpuInfo };
}

/**
 * Calculates statistical summary (mean, min, max, p95) for a numeric telemetry metric.
 * Discards null, undefined, and NaN entries.
 */
function calculateMetricSummary(samples, metricKey) {
  const values = samples
    .map(s => s.metrics?.[metricKey])
    .filter(v => typeof v === 'number' && !isNaN(v) && v !== null);

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
 * non-blocking async execution, and clean isolation between encoding configurations
 * and post-encode quality analysis.
 */
class TelemetryCollector {
  constructor(options = {}) {
    this.intervalMs = Math.max(200, options.intervalMs || 500);
    if (options.providerInfo) {
      this.providerInfo = options.providerInfo;
    } else if (typeof options.provider === 'string') {
      const isNvidia = options.provider === 'nvidia-smi';
      const isPdh = options.provider === 'pdh' || options.provider === 'windows-pdh';
      const throttlingSupported = options.throttlingSupported !== undefined
        ? Boolean(options.throttlingSupported)
        : !isPdh;
      this.providerInfo = {
        provider: options.provider,
        deviceAttribution: isNvidia ? 'verified' : (isPdh ? 'unverified' : 'unknown'),
        throttlingSupported,
        device: options.device || 'Host GPU',
        supportedFields: isNvidia ? ['gpu_utilization', 'memory_used', 'temperature', 'power', 'clock', 'throttling'] : (isPdh ? ['memory_used', 'clock'] : ['gpu_utilization', 'memory_used', 'temperature', 'power', 'clock', 'throttling']),
        unavailableFields: isNvidia ? [] : (isPdh ? ['throttling', 'temperature', 'power', 'gpu_utilization'] : [])
      };
    } else {
      this.providerInfo = detectTelemetryProvider();
    }
    this.signal = options.signal || null;
    this.samples = [];
    this.activePhase = 'idle_baseline';
    this.activeContext = {};
    this.timer = null;
    this.isRunning = false;
    this.isSampling = false;
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

    this.timer = setInterval(async () => {
      if (!this.isRunning) return;
      if (this.signal?.aborted) {
        this.stop();
        return;
      }
      if (this.isSampling) return; // Prevent overlapping async calls

      this.isSampling = true;
      const samplePhase = this.activePhase;
      const sampleContext = { ...this.activeContext };
      try {
        const { sample: s, currentCpuInfo: c } = await sampleHardwareStateAsync(this.providerInfo, this.prevCpuInfo);
        this.prevCpuInfo = c;
        s.phase = samplePhase;
        s.context = sampleContext;
        s.elapsedSec = Math.round(((Date.now() - this.startTimeMs) / 1000) * 10) / 10;
        this.samples.push(s);
      } catch {} finally {
        this.isSampling = false;
      }
    }, this.intervalMs);

    // Ensure timer does not prevent process exit
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  setPhase(phase, context = {}) {
    this.activePhase = phase;
    this.activeContext = { ...context };
  }

  get phase() {
    return this.activePhase;
  }

  recordSample(metrics = {}) {
    if (metrics.throttling === true || metrics.throttlingDetected === true || (Array.isArray(metrics.throttleReasons) && metrics.throttleReasons.length > 0)) {
      metrics.throttlingDetected = true;
      if (!metrics.activeThrottleReasons && Array.isArray(metrics.throttleReasons)) {
        metrics.activeThrottleReasons = metrics.throttleReasons;
      }
    }
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
   * If configId is specified, restricts analysis to samples tagged with that configuration.
   */
  getSummary(configId = null) {
    let encodingSamples = this.samples.filter(s => s.phase === 'encoding');
    if (configId) {
      encodingSamples = encodingSamples.filter(s => s.context?.configId === configId);
      if (encodingSamples.length === 0) {
        return {
          provider: this.providerInfo.provider,
          deviceAttribution: this.providerInfo.deviceAttribution,
          throttlingSupported: Boolean(this.providerInfo.throttlingSupported),
          sampleCount: 0,
          encoding: {
            sampleCount: 0,
            metrics: {},
            thermalClimbC: null,
            throttlingDetected: null,
            activeThrottleReasons: []
          },
          qualityAnalysis: {
            sampleCount: 0,
            metrics: {}
          }
        };
      }
    }

    const qualitySamples = this.samples.filter(s => s.phase === 'quality_analysis');

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
      .filter(v => typeof v === 'number' && !isNaN(v) && v !== null);
    const thermalClimb = temps.length >= 2
      ? Math.round((temps[temps.length - 1] - temps[0]) * 10) / 10
      : (temps.length === 1 ? 0 : null);

    // Active hardware throttling during encoding
    let throttlingSupported = Boolean(this.providerInfo.throttlingSupported);
    let throttlingDetected = null;
    let activeThrottleReasons = [];

    if (throttlingSupported) {
      const activeReasonsSet = new Set();
      let hasValidReading = false;
      let asserted = false;

      for (const s of encodingSamples) {
        const m = s.metrics || {};
        const isAsserted = m.throttlingDetected === true ||
          m.throttling === true ||
          (Array.isArray(m.throttleReasons) && m.throttleReasons.length > 0) ||
          (Array.isArray(m.activeThrottleReasons) && m.activeThrottleReasons.length > 0);

        const isUnasserted = m.throttlingDetected === false ||
          m.throttling === false ||
          m.throttling === 'None' ||
          (Array.isArray(m.throttleReasons) && m.throttleReasons.length === 0 && m.throttlingDetected !== null && m.throttling !== null) ||
          (Array.isArray(m.activeThrottleReasons) && m.activeThrottleReasons.length === 0 && m.throttlingDetected !== null && m.throttling !== null);

        if (isAsserted) {
          hasValidReading = true;
          asserted = true;
          const reasons = m.activeThrottleReasons || m.throttleReasons;
          if (Array.isArray(reasons)) {
            for (const r of reasons) {
              if (r && r !== 'None') activeReasonsSet.add(r);
            }
          } else if (typeof m.throttling === 'string' && m.throttling !== 'None') {
            activeReasonsSet.add(m.throttling);
          }
        } else if (isUnasserted) {
          hasValidReading = true;
        }
      }

      if (asserted) {
        throttlingDetected = true;
      } else if (hasValidReading) {
        throttlingDetected = false;
      } else {
        throttlingDetected = null;
      }
      activeThrottleReasons = [...activeReasonsSet];
    }

    return {
      provider: this.providerInfo.provider,
      device: this.providerInfo.device,
      driver: this.providerInfo.driver,
      intervalMs: this.intervalMs,
      totalSamples: this.samples.length,
      sampleCount: configId ? encodingSamples.length : this.samples.length,
      encodingSampleCount: encodingSamples.length,
      qualitySampleCount: qualitySamples.length,
      encoding: {
        sampleCount: encodingSamples.length,
        metrics: encodingMetrics,
        thermalClimbC: thermalClimb,
        throttlingSupported,
        throttlingDetected,
        activeThrottleReasons
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
  parseMetricNumber,
  decodeNvidiaThrottleReasons,
  detectTelemetryProvider,
  sampleHardwareState,
  sampleHardwareStateAsync,
  calculateMetricSummary,
  TelemetryCollector
};
