'use strict';

/**
 * Generates evidence-based, conservative configuration recommendations
 * strictly mapping to uburoom's production transcoding schema (server/config.js).
 */
function generateConfigurationRecommendations(benchmarkPayload, currentConfig = {}) {
  const currentTranscoding = currentConfig.transcoding || {};
  const results = benchmarkPayload.results || [];
  const concurrencySummary = benchmarkPayload.concurrencySummary || null;
  const passedResults = results.filter(r => r.status === 'pass');

  const recommendations = [];
  const insufficientEvidence = [];
  const warningsAndUncertainties = [];
  const untestedSettings = [];

  // 1. Encoder Recommendation (transcoding.encoder)
  const currentEncoderSetting = currentTranscoding.encoder || 'auto';
  const hwEncodersTested = passedResults.filter(r => ['nvenc', 'qsv'].includes(r.actualEncoder || r.requestedEncoder));
  const fallbacksObserved = results.some(r => r.fallbackEvents?.length > 0);

  const getSpeed = r => r.performance?.speedMultiplier ?? r.measurements?.speedRatio ?? 0;
  const getFps = r => r.performance?.effectiveFps ?? r.measurements?.fps ?? 0;

  if (hwEncodersTested.length > 0 && !fallbacksObserved) {
    const bestHw = hwEncodersTested.find(r => getSpeed(r) >= 1.5);
    if (bestHw) {
      const hwEncoderName = bestHw.actualEncoder || bestHw.requestedEncoder;
      const speed = getSpeed(bestHw);
      const fps = getFps(bestHw);
      if (currentEncoderSetting !== hwEncoderName) {
        recommendations.push({
          setting: 'transcoding.encoder',
          currentValue: currentEncoderSetting,
          recommendedValue: hwEncoderName,
          reason: `Dedicated hardware encoder (${hwEncoderName}) consistently delivered stable real-time encoding (${speed}x speed, ${fps.toFixed(1)} fps) with zero fallbacks.`,
          expectedBenefit: `Reduces CPU load to near zero and guarantees dedicated hardware video encoding for all active viewers.`,
          supportingEvidence: `Tested ${bestHw.codec.toUpperCase()} (${hwEncoderName}) @ ${bestHw.quality?.label || bestHw.quality?.id} in ${speed}x speed.`,
          confidence: 'high'
        });
      }
    } else {
      insufficientEvidence.push({
        setting: 'transcoding.encoder',
        reason: 'Hardware encoder was detected, but encoding throughput remained below the 1.5x real-time safety threshold.',
        neededTests: 'Test lower resolution profiles or check GPU driver and clocks.'
      });
    }
  } else if (fallbacksObserved) {
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
      // Conservative recommendation: provide at least 1 job of headroom if > 2, or keep tested
      const recommendedJobs = Math.max(1, highestTested > 2 ? highestTested - 1 : highestTested);
      if (recommendedJobs !== currentMaxJobs) {
        recommendations.push({
          setting: 'transcoding.max_jobs',
          currentValue: currentMaxJobs,
          recommendedValue: recommendedJobs,
          reason: `Capacity scan demonstrated sustainable real-time encoding up to ${highestTested} concurrent streams with zero missed deadlines. Applying conservative headroom of ${highestTested - recommendedJobs} stream(s) preserves playback reliability under network jitter.`,
          expectedBenefit: `Prevents server overload while utilizing verified GPU capacity.`,
          supportingEvidence: `Highest sustainable: ${highestTested} streams.`,
          confidence: highestTested >= 2 ? 'high' : 'medium'
        });
      }
    } else {
      warningsAndUncertainties.push('Concurrent capacity scan showed missed chunk deadlines or sub-real-time speed. Recommended max_jobs should be kept low (1-2) until hardware throughput improves.');
    }
  } else {
    insufficientEvidence.push({
      setting: 'transcoding.max_jobs',
      reason: 'No concurrent capacity scan was conducted during this benchmark run.',
      neededTests: 'Run benchmark with --capacity-scan --acknowledge-concurrency to measure sustainable multi-stream limits.'
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
      confidence: 'medium'
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
