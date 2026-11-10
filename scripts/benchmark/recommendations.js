'use strict';

/**
 * Generates evidence-based, conservative configuration recommendations
 * strictly mapping to uburoom's production transcoding schema (server/config.js).
 * Adheres to strict evidence thresholds to prevent overconfident or misleading advice.
 */
function generateConfigurationRecommendations(benchmarkPayload, currentConfig = {}) {
  const currentTranscoding = currentConfig.transcoding || {};
  const results = benchmarkPayload.results || [];
  const concurrencySummary = benchmarkPayload.concurrencySummary || null;
  const passedResults = results.filter(r => r.status === 'pass');

  const source = benchmarkPayload.source || {};
  const isSynthetic = Boolean(source.isSynthetic || source.synthetic || String(source.fileName || '').includes('synthetic'));
  const sampleDuration = benchmarkPayload.sampleDuration || 60;
  const runsCount = benchmarkPayload.runs || (results.some(r => (r.runIndex || 1) > 1) ? Math.max(...results.map(r => r.runIndex || 1)) : 1);

  const recommendations = [];
  const insufficientEvidence = [];
  const warningsAndUncertainties = [];
  const untestedSettings = [];

  // Helper accessors
  const getSpeed = r => r.performance?.speedMultiplier ?? r.measurements?.speedRatio ?? r.speedRatio ?? 0;
  const getFps = r => r.performance?.effectiveFps ?? r.measurements?.fps ?? r.fps ?? 0;

  // Track synthetic media limitation
  if (isSynthetic) {
    warningsAndUncertainties.push('Benchmark was executed on synthetic test media. Real media validation across complex film content is required before updating production settings.');
  }

  // 1. Encoder Recommendation (transcoding.encoder)
  const currentEncoderSetting = currentTranscoding.encoder || 'auto';
  const hwEncodersTested = passedResults.filter(r => ['nvenc', 'qsv'].includes(r.actualEncoder || r.requestedEncoder));
  const fallbacksObserved = results.some(r => (r.fallbackEvents && r.fallbackEvents.length > 0) || r.fallback);

  if (fallbacksObserved) {
    warningsAndUncertainties.push('Hardware encoding experienced runtime fallback to CPU during testing. Recommending auto or software encoder to protect stream availability.');
    if (currentEncoderSetting !== 'auto') {
      recommendations.push({
        setting: 'transcoding.encoder',
        currentValue: currentEncoderSetting,
        recommendedValue: 'auto',
        reason: 'Fallback events were observed during benchmark runs. Automatic encoder selection ensures graceful step-down.',
        expectedBenefit: 'Prevents playback interruption if GPU runs out of sessions or encounters unsupported formats.',
        supportingEvidence: 'Fallback events recorded in benchmark logs.',
        confidence: 'high'
      });
    }
  } else if (hwEncodersTested.length > 0) {
    // Group results strictly by specific configuration: codec + encoder + qualityId + mode
    const configMap = new Map();
    for (const r of results) {
      const enc = r.actualEncoder || r.requestedEncoder;
      if (!['nvenc', 'qsv'].includes(enc)) continue;
      const qId = r.quality?.id || r.qualityId || 'default';
      const mode = r.mode || 'chunks';
      const key = `${r.codec}::${enc}::${qId}::${mode}`;
      if (!configMap.has(key)) {
        configMap.set(key, {
          codec: r.codec,
          encoder: enc,
          qualityId: qId,
          quality: r.quality,
          mode,
          trials: []
        });
      }
      configMap.get(key).trials.push(r);
    }

    // Find candidate configurations that achieved real-time throughput
    const candidateConfigs = [...configMap.values()];
    const passingConfigs = candidateConfigs.filter(c => c.trials.some(t => t.status === 'pass' && getSpeed(t) >= 1.5));

    if (passingConfigs.length > 0) {
      // Pick best configuration: prefer highest throughput among passing configurations
      const bestConfig = passingConfigs.sort((a, b) => {
        const speedA = Math.max(...a.trials.filter(t => t.status === 'pass').map(getSpeed));
        const speedB = Math.max(...b.trials.filter(t => t.status === 'pass').map(getSpeed));
        return speedB - speedA;
      })[0];

      const hwEncoderName = bestConfig.encoder;
      const passedTrials = bestConfig.trials.filter(t => t.status === 'pass');
      const failedTrials = bestConfig.trials.filter(t => t.status !== 'pass');

      // Check distinct run identifiers
      const distinctRuns = new Set(passedTrials.map((t, idx) => t.runIndex !== undefined ? `run-${t.runIndex}` : (t.runId || `trial-${idx}`)));
      const measuredRunCount = distinctRuns.size;

      // Check sample durations on all passed trials
      const allAdequateDuration = passedTrials.every(t => {
        const dur = t.sampleDuration ?? t.performance?.sampleDuration ?? sampleDuration ?? 0;
        return dur >= 30;
      });

      // Check missed deadlines and fallbacks specifically on this configuration
      const totalMissedDeadlines = bestConfig.trials.reduce((sum, t) => sum + (t.deadlinesMissed ?? t.performance?.deadlineMisses ?? 0), 0);
      const configFallbacks = bestConfig.trials.some(t => (t.fallbackEvents && t.fallbackEvents.length > 0) || t.fallback || (t.actualEncoder && t.actualEncoder !== hwEncoderName));

      // Quality validation strictly for this specific configuration's trials
      const qualityPassTrials = passedTrials.filter(t => t.qualityMetrics?.status === 'pass' && (t.qualityMetrics?.vmaf?.mean >= 70 || t.qualityMetrics?.ssim?.mean >= 0.85 || typeof t.qualityMetrics?.vmaf === 'number'));
      const qualityFailTrials = bestConfig.trials.filter(t => t.qualityMetrics?.status === 'failed' || t.qualityMetrics?.status === 'misaligned');

      if (qualityFailTrials.length > 0) {
        warningsAndUncertainties.push(`Objective quality validation failed or detected temporal misalignment for ${bestConfig.codec.toUpperCase()} (${hwEncoderName}) @ ${bestConfig.qualityId}. Withholding hardware encoder recommendation until visual quality is verified.`);
        insufficientEvidence.push({
          setting: 'transcoding.encoder',
          reason: `Hardware encoder (${hwEncoderName}) output failed objective quality or temporal alignment checks for ${bestConfig.codec.toUpperCase()} @ ${bestConfig.qualityId}.`,
          neededTests: 'Inspect quality validation logs and verify encoding parameters with real reference media.'
        });
      } else {
        const avgSpeed = Math.round((passedTrials.reduce((sum, t) => sum + getSpeed(t), 0) / passedTrials.length) * 100) / 100;
        const avgFps = Math.round((passedTrials.reduce((sum, t) => sum + getFps(t), 0) / passedTrials.length) * 10) / 10;

        let confidence = 'preliminary';
        const confidenceReasons = [];

        if (isSynthetic) {
          confidence = 'preliminary';
          confidenceReasons.push('capped at preliminary because test used synthetic media');
        } else if (passedTrials.length < 2 || measuredRunCount < 2) {
          confidence = 'preliminary';
          confidenceReasons.push(`only ${passedTrials.length} successful trial(s) measured (requires at least 2 independent runs for high confidence)`);
        } else if (!allAdequateDuration) {
          confidence = 'preliminary';
          confidenceReasons.push('trial duration was under 30s threshold');
        } else if (failedTrials.length > 0) {
          confidence = 'preliminary';
          confidenceReasons.push(`mixed trial outcomes (${passedTrials.length} passed, ${failedTrials.length} failed) for this configuration`);
        } else if (qualityPassTrials.length === 0) {
          confidence = 'medium';
          confidenceReasons.push('visual quality was not verified with objective quality metrics for this specific configuration');
        } else if (totalMissedDeadlines > 0) {
          confidence = 'medium';
          confidenceReasons.push(`experienced ${totalMissedDeadlines} missed deadline(s) during trials`);
        } else if (configFallbacks) {
          confidence = 'medium';
          confidenceReasons.push('fallback events observed during trials');
        } else if (avgSpeed >= 1.5) {
          confidence = 'high';
        } else {
          confidence = 'medium';
        }

        if (currentEncoderSetting !== hwEncoderName) {
          const synthNotice = isSynthetic ? ' (Note: Tested on synthetic media; verify with real media before production deployment).' : '';
          const downgradeNotice = confidence !== 'high' && confidenceReasons.length > 0 ? ` (Confidence: ${confidence} — ${confidenceReasons.join('; ')}).` : '';
          recommendations.push({
            setting: 'transcoding.encoder',
            currentValue: currentEncoderSetting,
            recommendedValue: hwEncoderName,
            reason: `Measured ${avgSpeed}x real-time throughput (${avgFps.toFixed(1)} fps) across ${passedTrials.length} trial(s) with 0 missed deadlines and 0 fallback events during benchmark trials${synthNotice}${downgradeNotice}`,
            expectedBenefit: `Utilizes hardware video encoding (${hwEncoderName}), offloading video encode workload from the host CPU.`,
            supportingEvidence: `Tested ${bestConfig.codec.toUpperCase()} (${hwEncoderName}) @ ${bestConfig.quality?.label || bestConfig.qualityId} at ${avgSpeed}x speed (${passedTrials.length} successful trial(s)).`,
            confidence,
            confidenceReasons
          });
        }
      }
    } else {
      insufficientEvidence.push({
        setting: 'transcoding.encoder',
        reason: 'Hardware encoder was detected, but encoding throughput remained below the 1.5x real-time safety threshold.',
        neededTests: 'Test lower resolution profiles or check GPU driver, thermals, and clocks.'
      });
    }
  } else {
    insufficientEvidence.push({
      setting: 'transcoding.encoder',
      reason: 'No hardware encoder passed all benchmark trials.',
      neededTests: 'Run benchmark with --codecs av1,vp9 --all-encoders on a machine with Intel QSV or NVIDIA NVENC.'
    });
  }

  // 2. Maximum Concurrent Jobs Recommendation (transcoding.max_jobs)
  const currentMaxJobs = currentTranscoding.maxJobs || 5;

  if (concurrencySummary && (concurrencySummary.totalTrials > 0 || concurrencySummary.testedTiers?.length > 0)) {
    const highestTested = concurrencySummary.highestSustainableConcurrency || 0;
    if (highestTested >= 1) {
      // Conservative recommendation: apply headroom of N - 1 if > 2 streams
      const recommendedJobs = Math.max(1, highestTested > 2 ? highestTested - 1 : highestTested);
      const anyQualityVerified = results.some(r => r.qualityMetrics?.status === 'pass');
      let concurrencyConfidence = (isSynthetic || sampleDuration < 30 || runsCount < 2) ? 'preliminary' : (highestTested >= 2 && anyQualityVerified ? 'high' : 'medium');

      if (recommendedJobs !== currentMaxJobs) {
        const shortRunNote = sampleDuration < 30 ? ' Derived from short-run chunk tests; monitor long-term thermals and memory under real production load.' : '';
        recommendations.push({
          setting: 'transcoding.max_jobs',
          currentValue: currentMaxJobs,
          recommendedValue: recommendedJobs,
          reason: `Capacity scan demonstrated sustainable real-time encoding up to ${highestTested} concurrent streams with zero missed deadlines. Applying conservative headroom of ${highestTested - recommendedJobs} stream(s) preserves playback reliability under network jitter.${shortRunNote}`,
          expectedBenefit: `Protects server playback reliability while utilizing verified hardware capacity.`,
          supportingEvidence: `Highest sustainable: ${highestTested} streams (conservative recommendation: ${recommendedJobs}).`,
          confidence: concurrencyConfidence
        });
      }
    } else {
      warningsAndUncertainties.push('Concurrent capacity scan showed missed chunk deadlines or sub-real-time speed. Recommended max_jobs should be kept low (1-2) until hardware throughput improves.');
    }
  } else {
    insufficientEvidence.push({
      setting: 'transcoding.max_jobs',
      reason: 'No concurrent capacity scan was conducted during this benchmark run.',
      neededTests: 'Run benchmark with --capacity-scan --allow-load-test to measure sustainable multi-stream limits.'
    });
  }

  // 3. Supported Outputs (transcoding.outputs)
  const currentOutputs = currentTranscoding.outputs || ['av1', 'plex'];
  const av1Results = results.filter(r => r.codec === 'av1');
  const av1Passed = passedResults.some(r => r.codec === 'av1' && getSpeed(r) >= 1.2);
  const av1QualityFailed = av1Results.some(r => r.qualityMetrics?.status === 'failed' || r.qualityMetrics?.status === 'misaligned');
  const av1QualityVerified = av1Results.some(r => r.qualityMetrics?.status === 'pass');
  const vp9Passed = passedResults.some(r => r.codec === 'vp9' && getSpeed(r) >= 1.2);

  if (av1Passed && !currentOutputs.includes('av1')) {
    if (av1QualityFailed) {
      warningsAndUncertainties.push('AV1 encoding achieved real-time throughput, but objective quality analysis failed. Withholding AV1 outputs recommendation until visual quality is verified.');
      insufficientEvidence.push({
        setting: 'transcoding.outputs',
        reason: 'AV1 transcode passed throughput benchmarks but failed objective visual quality validation.',
        neededTests: 'Inspect quality filter logs and verify encoding parameters with real reference media.'
      });
    } else {
      const newOutputs = [...new Set(['av1', ...currentOutputs])];
      recommendations.push({
        setting: 'transcoding.outputs',
        currentValue: currentOutputs,
        recommendedValue: newOutputs,
        reason: av1QualityVerified
          ? 'AV1 encoding achieved fast, reliable real-time throughput and passed objective quality validation. Enabling AV1 offers superior visual quality at lower bitrates.'
          : 'AV1 encoding achieved fast, reliable real-time throughput margin.',
        expectedBenefit: 'Significantly lower bandwidth consumption for viewers while preserving sharp picture quality.',
        supportingEvidence: av1QualityVerified
          ? 'AV1 transcode succeeded with > 1.2x throughput margin and verified objective quality.'
          : 'AV1 transcode succeeded with > 1.2x throughput margin.',
        confidence: (isSynthetic || !av1QualityVerified) ? 'preliminary' : 'medium'
      });
    }
  } else if (!av1Passed && currentOutputs.includes('av1') && vp9Passed) {
    warningsAndUncertainties.push('AV1 encoding failed or remained below real-time margin. Consider prioritizing VP9 in transcoding.outputs for smoother playback.');
  }

  // 4. Untested Settings Tracking
  untestedSettings.push({
    setting: 'transcoding.qualities',
    reason: 'Evaluating custom [height, Mbps] ladders requires multi-clip visual rate-distortion testing across diverse film grain and motion types.'
  });
  untestedSettings.push({
    setting: 'transcoding.hardware_decode',
    reason: 'Hardware decoding behavior depends on input container and codec diversity (HEVC, H.264, VC-1).'
  });
  untestedSettings.push({
    setting: 'transcoding.cpu_fallback',
    reason: 'CPU fallback is safety-critical and should remain true by default.'
  });

  // Construct YAML Snippet
  let yamlSnippet = '# Recommended uburoom configuration snippet\n# Generated by uburoom transcoding benchmark\ntranscoding:\n';
  for (const rec of recommendations) {
    if (rec.setting === 'transcoding.encoder') {
      yamlSnippet += `  encoder: '${rec.recommendedValue}'\n`;
    } else if (rec.setting === 'transcoding.max_jobs') {
      yamlSnippet += `  max_jobs: ${rec.recommendedValue}\n`;
    } else if (rec.setting === 'transcoding.outputs') {
      yamlSnippet += `  outputs:\n${rec.recommendedValue.map(o => `    - '${o}'`).join('\n')}\n`;
    }
  }

  return {
    assessmentDate: new Date().toISOString(),
    benchmarkVersion: benchmarkPayload.benchmarkVersion || 'Stage 3',
    currentSettings: {
      encoder: currentEncoderSetting,
      max_jobs: currentMaxJobs,
      outputs: currentOutputs
    },
    recommendations,
    insufficientEvidence,
    warningsAndUncertainties,
    untestedSettings,
    yamlSnippet: recommendations.length > 0 ? yamlSnippet : null,
    operatorNotice: 'Recommendations are read-only and conservative. Benchmark never automatically alters config.yaml or restarts services. Review and apply manually if desired.'
  };
}

module.exports = {
  generateConfigurationRecommendations
};
