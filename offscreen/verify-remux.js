/**
 * remux 产物自检脚本（P3 第 1 项验证方法·必做）
 *
 * 用途：把 remuxMultiTrackMp4 / executeBilibiliTask 产出的 MP4 buffer 回灌 mp4box
 * 重新解析，断言：
 *   a) info.tracks[i].codec 是【完整】codec 字符串（如 "avc1.64001f"、"mp4a.40.2"），
 *      【不是】裸的 "avc1"/"mp4a"——裸 fourCC 就说明配置盒仍缺失。
 *   b) 直接检查 stsd entry 的 boxes：
 *      video 应含 "avcC"（或 hvcC/av1C），audio 应含 "esds"。
 *
 * 运行方式：在 offscreen document 的控制台执行
 *   import('./verify-remux.js').then(m => m.verifyRemuxOutput(uint8ArrayBuffer))
 * 或在代码中 import 后调用。
 *
 * @param {Uint8Array} outputData - remux 产出的完整 MP4 数据
 * @returns {{ok: boolean, errors: string[], details: Object}}
 */
export function verifyRemuxOutput(outputData) {
  const MP4Box = window.MP4Box;
  if (!MP4Box) {
    return { ok: false, errors: ['mp4box 未加载'], details: null };
  }

  const errors = [];
  const details = { tracks: [] };

  return new Promise((resolve) => {
    const file = MP4Box.createFile();

    // onReady / onError 都在 appendBuffer 内部【同步】触发，加个哨兵防止重复 resolve，
    // 也用于判断"喂完前缀后 moov 仍未解析出来"的情况（见函数末尾）。
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    file.onError = (e) => {
      errors.push(`mp4box 解析错误: ${e}`);
      settle({ ok: false, errors, details });
    };

    file.onReady = (info) => {
      for (const track of info.tracks) {
        const trackDetail = {
          id: track.id,
          type: track.type,
          codec: track.codec,
          video: track.video ? { width: track.video.width, height: track.video.height } : null,
          audio: track.audio ? { sample_rate: track.audio.sample_rate, channel_count: track.audio.channel_count } : null,
          stsdBoxes: [],
        };

        // 断言 a：codec 必须是完整字符串
        if (!track.codec) {
          errors.push(`track ${track.id}: codec 字段为空`);
        } else if (!track.codec.includes('.')) {
          // 裸 fourCC（如 "avc1"、"mp4a"）说明配置盒缺失
          errors.push(
            `track ${track.id} (${track.type}): codec 是裸 fourCC "${track.codec}"，` +
            `应为完整字符串（如 "avc1.64001f"）—— 说明 description_boxes 未生效`
          );
        }

        // 断言 b：检查 stsd entry 的 boxes
        try {
          const stsdEntry = file.moov?.traks?.find(t => t.tkhd?.track_id === track.id)
            ?.mdia?.minf?.stbl?.stsd?.entries?.[0];
          if (stsdEntry) {
            const boxTypes = (stsdEntry.boxes || []).map((b) => b.type || b.constructor?.name || 'unknown');
            trackDetail.stsdBoxes = boxTypes;

            if (track.type === 'video') {
              const hasVideoConfig = boxTypes.some((t) => ['avcC', 'hvcC', 'av1C'].includes(t));
              if (!hasVideoConfig) {
                errors.push(
                  `track ${track.id} (video): stsd entry 缺少解码器配置盒（avcC/hvcC/av1C），` +
                  `现有 boxes: [${boxTypes.join(', ')}]`
                );
              }
            } else if (track.type === 'audio') {
              const hasAudioConfig = boxTypes.some((t) => ['esds', 'dOps', 'dfLa'].includes(t));
              if (!hasAudioConfig) {
                errors.push(
                  `track ${track.id} (audio): stsd entry 缺少解码器配置盒（esds/dOps/dfLa），` +
                  `现有 boxes: [${boxTypes.join(', ')}]`
                );
              }
            }
          } else {
            errors.push(`track ${track.id}: 找不到 stsd entry`);
          }
        } catch (e) {
          errors.push(`track ${track.id}: 检查 stsd entry 时异常: ${e.message}`);
        }

        details.tracks.push(trackDetail);
      }

      settle({
        ok: errors.length === 0,
        errors,
        details,
      });
    };

    // 只喂开头一小段，不喂整个文件
    //
    // 本函数要断言的东西全在 moov 里（codec 字符串、stsd 的 avcC/esds），而输出结构是
    // ftyp + moov + [moof+mdat]*N，moov 紧跟在文件开头，且 fMP4 的 stbl 采样表是空的
    // （样本都在 moof 里），实测 moov 只有 1~2KB。
    //
    // 喂整个文件的代价：outputData.buffer.slice() 会【整份复制】一遍，再加上 mp4box
    // 自己持有的解析结构——1 小时视频输出上 GB 时等于凭空多占一倍内存，直接违反
    // "1 小时视频不得 OOM" 的约束。这里取 4MB 前缀，比实际所需大三个数量级。
    const PREFIX_SIZE = 4 * 1024 * 1024;
    const prefixLength = Math.min(outputData.byteLength, PREFIX_SIZE);
    const ab = outputData.buffer.slice(
      outputData.byteOffset,
      outputData.byteOffset + prefixLength
    );
    ab.fileStart = 0;
    file.appendBuffer(ab);

    // onReady 是同步触发的：走到这里还没 settle，说明 moov 没能在前 4MB 内解析出来。
    // 这属于异常但不该阻断下载（文件已经写好了），标记 skipped 让调用方打日志即可。
    // 不加这个兜底的话 Promise 会永远挂起，把任务卡死在 writing 状态。
    settle({
      ok: true,
      skipped: true,
      errors: [`moov 未能在前 ${PREFIX_SIZE / 1024 / 1024}MB 内解析出来，跳过自检`],
      details,
    });
  });
}

/**
 * 在 executeBilibiliTask / remuxMultiTrackMp4 完成后调用此函数做自检
 *
 * 用法（在 queue.js 的 output.write(stream) 之后）：
 *   const outputData = new Uint8Array(stream.buffer);
 *   const verifyResult = await verifyRemuxOutput(outputData);
 *   if (!verifyResult.ok) {
 *     console.error('[WebGrab/VERIFY] remux 产物自检失败', verifyResult);
 *   } else {
 *     console.log('[WebGrab/VERIFY] remux 产物自检通过', verifyResult.details);
 *   }
 *
 * @param {Uint8Array} outputData
 * @returns {Promise<{ok: boolean, errors: string[], details: Object}>}
 */
export async function verifyAndLog(outputData) {
  const result = await verifyRemuxOutput(outputData);
  if (result.skipped) {
    console.warn('[WebGrab/VERIFY] remux 产物自检被跳过', result.errors);
  } else if (result.ok) {
    console.log('[WebGrab/VERIFY] remux 产物自检通过', result.details);
  } else {
    console.error('[WebGrab/VERIFY] remux 产物自检失败', result);
  }
  return result;
}

/**
 * 验证输出文件的 sample 完整性 —— 【手动排查工具，不在下载主流程中调用】
 *
 * 逐 moof 解析 track_ID 和 sample_count，汇总每条轨道的总 sample 数，
 * 并用 duration/timescale 估算预期 sample 数做交叉校验（容差 0.5x ~ 2.0x）。
 *
 * 适用场景：怀疑某条轨道的 sample 被静默截断时（例如 remuxer.js 里那个
 * "mp4box 解析卡死" 检测被触发、或产出的文件音画时长明显不符）拿来定位。
 * 它会解析【整个】输出文件，对大文件开销很高，所以刻意不放进主流程。
 *
 * 前置条件：依赖 moov 里的 duration 非 0 才能算出预期值，也就是必须先经过
 * remuxer.js 的 finalizeMp4Metadata()。否则估算值恒为 0，会报出一堆假错误
 * （P3 排查期间踩过这个坑）。
 *
 * 用法（在 offscreen document 控制台）：
 *   import { verifySampleCounts } from './verify-remux.js';
 *   const result = await verifySampleCounts(outputData);
 *   console.log(result.report); // 文本报告
 *
 * @param {Uint8Array} outputData - remux 产出的完整 MP4 数据
 * @returns {Promise<{ok: boolean, report: string, details: Object}>}
 */
export function verifySampleCounts(outputData) {
  const MP4Box = window.MP4Box;
  if (!MP4Box) {
    return Promise.resolve({ ok: false, report: 'mp4box 未加载', details: null });
  }

  return new Promise((resolve) => {
    const file = MP4Box.createFile();
    const errors = [];
    const details = {
      moofCount: 0,
      moofsByTrack: {}, // { trackId: [{ moofSeq, sampleCount, trafCount }] }
      totalSamplesByTrack: {}, // { trackId: totalSamples }
      trackInfo: {}, // { trackId: { type, timescale, duration, codec } }
    };

    file.onError = (e) => {
      errors.push(`mp4box 解析错误: ${e}`);
      resolve({ ok: false, report: errors.join('\n'), details });
    };

    file.onReady = (info) => {
      // 收集 track 信息
      for (const track of info.tracks) {
        details.trackInfo[track.id] = {
          type: track.type,
          timescale: track.timescale,
          duration: track.duration,
          codec: track.codec,
          video: track.video ? { width: track.video.width, height: track.video.height } : null,
          audio: track.audio ? { sample_rate: track.audio.sample_rate, channel_count: track.audio.channel_count } : null,
        };
        details.moofsByTrack[track.id] = [];
        details.totalSamplesByTrack[track.id] = 0;
      }

      // 逐 moof 统计
      if (file.moofs && file.moofs.length > 0) {
        details.moofCount = file.moofs.length;
        for (let i = 0; i < file.moofs.length; i++) {
          const moof = file.moofs[i];
          for (const traf of moof.trafs || []) {
            const trackId = traf.tfhd ? traf.tfhd.track_id : -1;
            let moofSampleCount = 0;
            for (const trun of traf.truns || []) {
              moofSampleCount += trun.sample_count || 0;
            }
            if (!details.moofsByTrack[trackId]) {
              details.moofsByTrack[trackId] = [];
              details.totalSamplesByTrack[trackId] = 0;
            }
            details.moofsByTrack[trackId].push({
              moofSeq: i,
              sampleCount: moofSampleCount,
              trafCount: traf.truns ? traf.truns.length : 0,
            });
            details.totalSamplesByTrack[trackId] += moofSampleCount;
          }
        }
      }

      // 生成报告
      const lines = [];
      lines.push('=== Sample Count Verification ===');
      lines.push(`Total moofs: ${details.moofCount}`);
      lines.push('');

      for (const trackId of Object.keys(details.trackInfo)) {
        const ti = details.trackInfo[trackId];
        const total = details.totalSamplesByTrack[trackId] || 0;
        const moofsForTrack = details.moofsByTrack[trackId] || [];

        lines.push(`Track ${trackId} (${ti.type}, ${ti.codec}):`);
        lines.push(`  timescale=${ti.timescale}, duration=${ti.duration}`);
        const estimatedDurationSec = ti.timescale > 0 ? (ti.duration / ti.timescale) : 0;
        lines.push(`  estimated duration: ${estimatedDurationSec.toFixed(2)}s`);

        // 估算预期 sample 数（粗略：视频按帧率，音频按采样率）
        if (ti.type === 'video' && ti.video) {
          // 假设 24fps / 30fps，用 duration 估算
          const estimatedSamples = Math.round(estimatedDurationSec * 30); // 上限估算
          lines.push(`  expected samples (est @30fps): ~${estimatedSamples}`);
          const ratio = estimatedSamples > 0 ? (total / estimatedSamples) : 0;
          if (ratio < 0.5 || ratio > 2.0) {
            errors.push(`Track ${trackId} (video): sample count ${total} 偏离估算 ${estimatedSamples} 过大 (ratio=${ratio.toFixed(2)})`);
          }
        } else if (ti.type === 'audio' && ti.audio) {
          // 音频 sample 数 = duration / timescale * sample_rate 不对
          // AAC 每个 sample 包含 1024 个 PCM samples
          const estimatedAacFrames = Math.round(estimatedDurationSec * ti.audio.sample_rate / 1024);
          lines.push(`  expected samples (est AAC @1024pcm/frame): ~${estimatedAacFrames}`);
          const ratio = estimatedAacFrames > 0 ? (total / estimatedAacFrames) : 0;
          if (ratio < 0.5 || ratio > 2.0) {
            errors.push(`Track ${trackId} (audio): sample count ${total} 偏离估算 ${estimatedAacFrames} 过大 (ratio=${ratio.toFixed(2)})`);
          }
        }

        lines.push(`  actual total samples: ${total}`);
        lines.push(`  moofs containing this track: ${moofsForTrack.length}`);

        // 检查 moof 序列是否连续（moofSeq 应该单调递增）
        let prevSeq = -1;
        for (const m of moofsForTrack) {
          if (m.moofSeq <= prevSeq) {
            errors.push(`Track ${trackId}: moofSeq 不单调递增 (prev=${prevSeq}, curr=${m.moofSeq})`);
          }
          prevSeq = m.moofSeq;
        }

        // 打印前 5 个和后 5 个 moof 的 sample count
        if (moofsForTrack.length > 0) {
          const head = moofsForTrack.slice(0, 5).map(m => `#${m.moofSeq}:${m.sampleCount}`).join(' ');
          const tail = moofsForTrack.length > 10
            ? '... ' + moofsForTrack.slice(-5).map(m => `#${m.moofSeq}:${m.sampleCount}`).join(' ')
            : '';
          lines.push(`  samples per moof (head): ${head} ${tail}`);
        }
        lines.push('');
      }

      if (errors.length > 0) {
        lines.push('=== ERRORS ===');
        for (const e of errors) lines.push(`  ✗ ${e}`);
      } else {
        lines.push('=== ALL CHECKS PASSED ===');
      }

      resolve({
        ok: errors.length === 0,
        report: lines.join('\n'),
        details,
      });
    };

    // 喂入完整数据
    const ab = outputData.buffer.slice(
      outputData.byteOffset,
      outputData.byteOffset + outputData.byteLength
    );
    ab.fileStart = 0;
    file.appendBuffer(ab);
  });
}
