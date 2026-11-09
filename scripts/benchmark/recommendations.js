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

  // Quality check across tested hardware encoders
  const qualityFailedOrMisaligned = hwEncodersTested.some(r => r.qualityMetrics?.status === 'failed' || r.qualityMetrics?.status === 'misaligned');
  const qualityVerified = hwEncodersTested.some(r => r.qualityMetrics?.status === 'pass');

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
  } else if (qualityFailedOrMisaligned) {
    warningsAndUncertainties.push('Objective quality validation failed or detected temporal misalignment for hardware encoded streams. Withholding hardware encoder recommendation until visual quality is verified.');
    insufficientEvidence.push({
      setting: 'transcoding.encoder',
      reason: 'Hardware encoder output failed objective quality or temporal alignment checks.',
      neededTests: 'Inspect quality validation logs and verify encoding parameters with real reference media.'
    });
  } else if (hwEncodersTested.length > 0) {
    const bestHw = hwEncodersTested.find(r => getSpeed(r) >= 1.5);
    if (bestHw) {
      const hwEncoderName = bestHw.actualEncoder || bestHw.requestedEncoder;
      const speed = getSpeed(bestHw);
      const fps = getFps(bestHw);

      // Determine confidence level strictly based on evidence
      let confidence = 'preliminary';
      const confidenceReasons = [];

      if (isSynthetic) {
        confidenceReasons.push('capped at preliminary because test used synthetic media');
      } else if (runsCount < 2 || sampleDuration < 30) {
        confidenceReasons.push(`preliminary observation from ${runsCount} run(s) over ${sampleDuration}s interval`);
      } else if (speed >= 1.5 && !fallbacksObserved && (qualityVerified || !bestHw.qualityMetrics)) {
        confidence = 'high';
      } else {
        confidence = 'medium';
      }

      if (currentEncoderSetting !== hwEncoderName) {
        const synthNotice = isSynthetic ? ' (Note: Tested on synthetic media; verify with real media before production deployment).' : '';
        recommendations.push({
          setting: 'transcoding.encoder',
          currentValue: currentEncoderSetting,
          recommendedValue: hwEncoderName,
          reason: `Measured ${speed}x real-time throughput (${fps.toFixed(1)} fps) with 0 missed deadlines and 0 fallback events during benchmark trials${synthNotice}`,
          expectedBenefit: `Utilizes hardware video encoding (${hwEncoderName}), offloading video encode workload from the host CPU.`,
          supportingEvidence: `Tested ${bestHw.codec.toUpperCase()} (${hwEncoderName}) @ ${bestHw.quality?.label || bestHw.quality?.id} at ${speed}x speed.`,
          confidence
        });
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
      let concurrencyConfidence = isSynthetic || sampleDuration < 30 ? 'preliminary' : (highestTested >= 2 ? 'high' : 'medium');

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
  const av1Passed = passedResults.some(r => r.codec === 'av1' && getSpeed(r) >= 1.2);
  const vp9Passed = passedResults.some(r => r.codec === 'vp9' && getSpeed(r) >= 1.2);

  if (av1Passed && !currentOutputs.includes('av1')) {
    const newOutputs = [...new Set(['av1', ...currentOutputs])];
    recommendations.push({
      setting: 'transcoding.outputs',
      currentValue: currentOutputs,
      recommendedValue: newOutputs,
      reason: 'AV1 encoding achieved fast, reliable real-time throughput. Enabling AV1 offers superior visual quality at lower bitrates.',
      expectedBenefit: 'Significantly lower bandwidth consumption for viewers while preserving sharp picture quality.',
      supportingEvidence: 'AV1 transcode succeeded with > 1.2x throughput margin.',
      confidence: isSynthetic ? 'preliminary' : 'medium'
    });
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
