/**
 * 容器合并器 —— Offscreen Document 中使用
 *
 * 三条路径：
 *
 * 1. fMP4 单轨道直接拼接（最快路径，无需 mp4box）：
 *    - 适用：HLS fMP4（init segment + moof+mdat fragments）
 *    - init segment 写一次，后续每个 fragment 原样追加写盘
 *    - 真正的流式：fragment 到达即写，内存恒定
 *    - 产出的 fragmented MP4 可被现代播放器（VLC/MPV/Chrome）正常播放
 *
 * 2. fMP4 多轨道合并（mp4box.js，正确的异步回调 API）：
 *    - 适用：DASH video+audio 分离的 fMP4 分片
 *    - 用 onReady(info) 拿 track 信息，setExtractionOptions+start()+onSamples 拿 samples
 *    - 用 DataStream 写出合并后的 MP4
 *
 * 3. 兜底路径（ffmpeg.wasm）：见 ffmpeg-fallback.js
 *    - 适用：TS 分片转 MP4、AV1/Dolby、上述路径失败的异常情况
 *
 * 选路逻辑：探测 codecs → 判断能否快路径 → 单轨道直接拼接 / 多轨道 mp4box / 兜底 ffmpeg
 */

let mp4boxLoaded = false;

/**
 * 加载 mp4box 库
 *
 * 注意：mp4box.all.min.js 在 <script> 标签环境下导出的全局是
 *   window.MP4Box（大写，仅含 createFile 方法）
 *   window.DataStream（独立全局，不挂在 MP4Box 下）
 *   window.ISOFile / window.BoxParser（同样是独立全局）
 * 不是 window.mp4box（小写）。
 */
export async function loadMp4box() {
  if (mp4boxLoaded) return;
  // offscreen document 通过 <script> 标签预加载（见 downloader.html）
  if (typeof window !== 'undefined' && window.MP4Box && window.DataStream) {
    mp4boxLoaded = true;
    return;
  }
  throw new Error('mp4box 未加载，请检查 downloader.html 是否包含 <script src="../lib/mp4box.all.min.js">');
}

/**
 * @typedef {Object} TrackInput
 * @property {string}   type         - "video" | "audio"
 * @property {Uint8Array} [initSegment] - init segment（fMP4 的 moov box）
 * @property {Array}    segments     - 分片数据数组（每个元素 { data: Uint8Array }）
 * @property {number}   [timescale]  - 时间刻度
 * @property {number}   [duration]   - 总时长（秒）
 * @property {string}   [codecs]     - 编码字符串
 */

// ─── 选路逻辑 ────────────────────────────────────────────

/**
 * 判断 codecs 是否可以走快路径（mp4box -c copy 或直接拼接）
 *
 * 支持：avc1/avc3（H.264）、hev1/hvc1（HEVC）、mp4a（AAC）、fLaC、Opus、mp3
 * 不支持：av01（AV1）、dvh1/dvc1（Dolby Vision）、ac-3（AC3）、ec-3（EAC3）、vp09（VP9）
 *
 * @param {string} codecs - codecs 字符串（如 "avc1.64001f,mp4a.40.2"）
 * @returns {boolean}
 */
export function canFastPath(codecs) {
  if (!codecs) return true; // 未知 codecs 时保守地允许快路径，失败再回退
  const parts = codecs.split(',').map((s) => s.trim().toLowerCase());

  const unsupportedPrefixes = [
    'av01',           // AV1
    'dvh1', 'dvc1',   // Dolby Vision
    'dvav', 'dvhe',   // Dolby Vision variants
    'ac-3', 'ac3',    // AC3
    'ec-3', 'eac3',   // EAC3
    'vp09', 'vp9',    // VP9
  ];

  for (const part of parts) {
    if (unsupportedPrefixes.some((p) => part.startsWith(p))) {
      return false;
    }
  }
  return true;
}

/**
 * 简化的 TS → MP4 转换检测
 * @param {string} codecs
 * @param {string} [containerType] - "fmp4" | "ts"
 * @returns {boolean} 是否需要 ffmpeg
 */
export function needsFfmpeg(codecs, containerType) {
  if (containerType === 'ts') return true;
  return !canFastPath(codecs);
}

// ─── 最快路径：fMP4 单轨道直接拼接 ──────────────────────

/**
 * fMP4 单轨道直接拼接（流式）
 *
 * 原理：fragmented MP4 = init segment (ftyp + moov) + N × fragment (moof + mdat)
 * 每个 fragment 是自包含的，直接原样追加即可产生可播放的 fMP4 文件。
 * 不需要用 mp4box 解析出 sample 再重新打包——那是多轨道交织才需要的。
 *
 * 内存约束：fragment 通过 onSegment 回调到达时立即写盘并释放引用，
 * 内存占用恒定在单个 fragment 大小。
 *
 * @param {Object} params
 * @param {Uint8Array} params.initSegment - init segment (moov)
 * @param {Object} params.writer - FileWriter 实例
 * @param {number} [params.totalSegments] - 总分片数（进度计算用）
 * @param {(written: number, total: number) => void} [params.onSegmentWritten] - 每片写完回调
 * @returns {Promise<{method: 'concat', duration: number}>}
 */
export async function concatFmp4Stream({ initSegment, writer, totalSegments = 0, onSegmentWritten }) {
  if (!initSegment || initSegment.length === 0) {
    throw new Error('concatFmp4Stream 需要 init segment');
  }

  // 1. 写 init segment（ftyp + moov）
  await writer.write(initSegment, 0);

  return {
    method: 'concat',
    duration: 0, // 由调用方估算
    /**
     * 流式写入一个 fragment
     * @param {Uint8Array} fragmentData
     * @param {number} offset - 当前写入偏移量（由调用方维护）
     * @returns {Promise<number>} 写入后的新偏移量
     */
    async writeFragment(fragmentData, offset) {
      await writer.write(fragmentData, offset);
      if (onSegmentWritten) {
        // 进度回调
      }
      return offset + fragmentData.byteLength;
    },
  };
}

/**
 * 流式拼接 fMP4 单轨道
 *
 * 这是一个便利函数，封装了 concatFmp4Stream 的完整流程：
 * 写 init → 逐个写 fragment → 返回。
 * 适合在 queue.js 的 onSegment 回调中调用。
 *
 * @param {Uint8Array} initSegment
 * @param {Object} writer - FileWriter 实例
 * @param {AsyncIterable<{data: Uint8Array}>} fragmentIterable - 分片异步迭代器
 * @param {(progress: number) => void} [onProgress] - 0-1
 * @returns {Promise<{method: 'concat', duration: number}>}
 */
export async function streamConcatFmp4(initSegment, writer, fragmentIterable, onProgress) {
  // 写 init segment
  await writer.write(initSegment, 0);

  let offset = initSegment.byteLength;
  let written = 0;
  let total = 0;

  for await (const fragment of fragmentIterable) {
    await writer.write(fragment.data, offset);
    offset += fragment.data.byteLength;
    written++;

    if (onProgress && total > 0) {
      onProgress(written / total);
    }
  }

  return { method: 'concat', duration: 0 };
}

// ─── mp4box 多轨道合并 ───────────────────────────────────
//
// 实现依据：gpac/mp4box.js 官方仓库示例（demo/multitracks/mtsdsb.js）+ 源码验证。
//
// 关键 API 事实（从 src/isofile.js、src/buffer.js 源码验证）：
//
// 1. onReady 和 onSamples 都是【同步】回调，在 appendBuffer() 内部触发：
//      appendBuffer(ab) → parse() → processSamples() → onSamples()
//    所以可以在 appendBuffer 返回后立即处理 samples，不需要 Promise/setTimeout。
//
// 2. fileStart 必须是【累计偏移量】，不是每次都填 0：
//      - MultiBufferStream.insertBuffer 按 fileStart 排序、去重、不允许重叠
//      - 如果两次 appendBuffer 都用 fileStart=0，第二次会被静默丢弃或覆盖第一次的数据
//      - 正确做法：init 用 0，后续 fragment 用 prevOffset += prevBuf.byteLength
//
// 3. fMP4 fragment（moof+mdat）依赖同一 ISOFile 实例中之前解析过的 init segment（moov）
//    才能被正确 demux。每次 fragment 都新建 ISOFile 是错的——那个实例从没见过 init segment，
//    onSamples 永远不会触发。
//
// 4. setExtractionOptions + start() 必须在 onReady 内调用（此时 moov 已解析完成），
//    否则 processSamples 里的 if (!this.sampleProcessingStarted) return 会阻止 onSamples。
//
// 5. 输出用独立的 ISOFile：先 addTrack()，再对每个 sample 调用 addSample()，
//    最后 write(DataStream) 序列化。addSample 内部会为每个 sample 创建单样本 moof+mdat，
//    所以输出自然是 fragmented MP4。
//
// 多轨道场景（DASH video+audio 分离）：两条独立的 fMP4 流各有自己的 init segment，
// 因此需要两个输入 ISOFile 实例（一个解析 video 流，一个解析 audio 流），
// 加一个输出 ISOFile 用于合并。samples 通过 onSamples 回调从输入流到输出流。

/**
 * 创建一个输入流处理器：喂入 init segment + fragments，通过 onSamples 输出 samples
 *
 * 关键修复（P3 onSamples 停止触发 bug）：
 *   onSamples 回调后立即调用 file.releaseUsedSamples()，释放 input ISOFile 中
 *   已提取 sample 的 .data 引用（Uint8Array）。这不是可选项——mp4box.js 的
 *   getSample() 为每个 sample 分配 new Uint8Array(r.size) 并计入 samplesDataSize，
 *   但 releaseUsedSamples 是唯一释放途径。不调用 → samplesDataSize 无上限增长 →
 *   input 侧的 sample.data 引用永不释放 → cleanBuffers 无法回收 buffer
 *   （usedBytes 达不到 byteLength，因为 mdat 数据虽被 getSample 标记 used，
 *    但 sample.data 副本仍占内存）→ 最终内存压力或内部状态异常导致 onSamples 停止。
 *
 *   数据安全（已通过源码分析确认）：
 *   - getSample: r.data = new Uint8Array(r.size) + DataStream.memcpy → 独立分配
 *   - addSample: this.add("mdat").data = new Uint8Array(e) → 逐字节拷贝
 *   - addSample 在 releaseUsedSamples 之前就完成了数据拷贝
 *   所以 output 侧的 sample.data 不会被 releaseUsedSamples/cleanBuffers 影响。
 *
 * @param {Uint8Array} initSegment - 该轨道的 init segment
 * @param {(samples: Array) => void} onSamples - samples 回调（同步触发）
 * @returns {Promise<{info: Object, getSampleEntry: (trackId: number) => Object|null, appendFragment: (data: Uint8Array, fileStart?: number) => void, flush: () => void}>}
 */
export function createInputProcessor(initSegment, onSamples) {
  return new Promise((resolve, reject) => {
    const MP4Box = window.MP4Box;
    if (!MP4Box) {
      reject(new Error('mp4box 未加载'));
      return;
    }

    const file = MP4Box.createFile();
    let ready = false;
    /** 累计的文件偏移量，给下一个 appendBuffer 用 */
    let nextFileStart = 0;
    /** 累计已交付的 sample 数，用于 releaseUsedSamples 的索引 */
    let totalSamplesDelivered = 0;
    /** trackId（onReady 时确定，releaseUsedSamples 需要） */
    let trackIdForRelease = null;

    /**
     * Box 边界对齐缓冲（修复 mp4box 跨块 box 头截断卡死）
     *
     * 问题：网络下载的分块边界（约 5.6MB）与 mp4 box 边界无关。一个 box 头
     * （8 字节 size+type，或 16 字节含 64 位扩展 size）有极小概率恰好被切在
     * 两次 appendBuffer 调用的分界线上。mp4box.js 的 MultiBufferStream 在处理
     * "box 头跨两次 append 被截断"这种边界情况上可能有 bug，导致 box 位置算错、
     * 解析器永久卡死。
     *
     * 修复：在喂给 mp4box 之前，自己先按 box 头解析出完整 box，只把"整数个完整
     * box"喂给 appendBuffer，不完整的尾部字节留到下一块数据到达时拼接再解析。
     * 这样保证喂给 mp4box 的每次调用边界永远落在 box 边界上。
     *
     * @type {{data: Uint8Array, fileStart: number}|null}
     */
    let alignBuffer = null;

    /**
     * 卡死检测（stall detection）
     *
     * 已确认的真实 bug：mp4box.js 在增量 appendBuffer 解析跨块 mdat 时，
     * 偶发把 box 边界算错（把媒体载荷字节误读成下一个 box 的 size 字段，
     * 得到一个不可能满足的巨大 size），导致 file.lastBoxStartPosition
     * 永久卡住不再前进——不抛异常、不报错，appendBuffer 会继续把后续所有
     * 数据吞掉却不再产出新 sample，任务表现为"成功"但视频轨道被静默截断。
     *
     * 由于问题在 mp4box.js 内部、且难以在不引入第三方库维护成本的前提下
     * 定位根治，这里改为主动检测+快速失败：正常的单个 fragment/mdat 不会
     * 超过 STALL_THRESHOLD_BYTES 这个量级，如果 box 位置连续无进展、且已
     * 白白喂入超过该阈值的新数据，直接判定为解析器卡死并抛错，好过让它
     * 悄悄产出一个截断的坏文件。
     */
    const STALL_THRESHOLD_BYTES = 16 * 1024 * 1024;
    let lastKnownBoxPos = 0;
    let stalledExtraBytes = 0;

    file.onError = (e) => {
      reject(new Error('mp4box 解析错误: ' + e));
    };

    file.onReady = (info) => {
      ready = true;
      // 对该文件中的所有 track 启用 sample 提取
      // （单轨道 init segment 通常只有一个 track）
      for (const track of info.tracks) {
        file.setExtractionOptions(track.id, null);
        if (trackIdForRelease === null) trackIdForRelease = track.id;
      }
      file.onSamples = (_trackId, _user, samples) => {
        // 同步触发：在 appendBuffer 内部调用
        if (samples.length > 0) {
          onSamples(samples);
          // 释放 input ISOFile 中已提取 sample 的 .data 引用
          // 必须在 onSamples 之后调用——此时调用方已通过 batchedWriter.push()
          // 或 addSample() 创建了独立数据副本，释放 input 侧引用安全。
          totalSamplesDelivered += samples.length;
          if (trackIdForRelease !== null) {
            file.releaseUsedSamples(trackIdForRelease, totalSamplesDelivered);
          }
        }
      };
      file.start();

      resolve({
        info,
        /**
         * 读取该轨道的源 sample entry（含 avcC/esds/av1C/hvcC 等解码器配置盒）
         *
         * 为什么需要这一步：mp4box.js 的 output.addTrack() 是从参数【重新构造】
         * sample entry 的，不会携带源流的解码器配置盒。mp4a 无 esds → AAC 解码器
         * 无法初始化 → 静音；avc1 无 avcC → 无 SPS/PPS。
         * 通过把源 sample entry 的 boxes 原样作为 description_boxes 传给 addTrack，
         * 可以让 mp4box 直接复用源配置盒（mp4box 自己内部 itemToFragmentedTrackFile
         * 也是这么做的）。
         *
         * @param {number} trackId - 源 track id（来自 info.tracks[i].id）
         * @returns {Object|null} sample entry 对象，含 type/boxes 字段，或 null
         */
        getSampleEntry(trackId) {
          const trak = file.getTrackById(trackId);
          return trak?.mdia?.minf?.stbl?.stsd?.entries?.[0] || null;
        },
        /**
         * 追加一个 fragment
         *
         * fileStart 参数说明：
         *   - 不传（默认）：使用内部累计的 nextFileStart，适用于顺序喂入
         *   - 显式传入：用于 B 站单 URL 流式下载，chunk.offset 即文件偏移
         *     mp4box 的 MultiBufferStream 会按 fileStart 排序、去重，支持乱序插入
         *
         * Box 边界对齐：在喂给 mp4box 之前，先按 box 头（4 字节 big-endian size +
         * 4 字节 type，size===1 时读后续 8 字节 64 位扩展 size）解析出完整 box，
         * 只把整数个完整 box 喂给 appendBuffer，不完整的尾部留到下次拼接再解析。
         * 这样保证喂给 mp4box 的每次调用边界永远落在 box 边界上，避免 mp4box.js
         * 的 MultiBufferStream 在处理"box 头跨两次 append 被截断"时卡死。
         *
         * @param {Uint8Array} fragmentData
         * @param {number} [fileStart] - 可选的显式文件偏移量
         */
        appendFragment(fragmentData, fileStart) {
          const baseOffset = (fileStart != null) ? fileStart : nextFileStart;

          // 1. 拼接残余缓冲 + 新数据
          /** @type {Uint8Array} */
          let data;
          /** @type {number} 拼接后数据的起始文件偏移 */
          let dataOffset;
          if (alignBuffer) {
            const merged = new Uint8Array(alignBuffer.data.byteLength + fragmentData.byteLength);
            merged.set(alignBuffer.data, 0);
            merged.set(fragmentData, alignBuffer.data.byteLength);
            data = merged;
            dataOffset = alignBuffer.fileStart;
            alignBuffer = null;
          } else {
            data = fragmentData;
            dataOffset = baseOffset;
          }

          // 2. 按 box 边界解析，确定完整 box 的结束位置
          let consumeEnd = 0; // 已确认完整的 box 数据结束位置
          let pos = 0;
          while (pos + 8 <= data.byteLength) {
            // 读 4 字节 big-endian size
            const size = (data[pos] * 0x1000000) + (data[pos + 1] << 16) +
                         (data[pos + 2] << 8) + data[pos + 3];

            let headerSize = 8;
            let boxSize;

            if (size === 1) {
              // 64 位扩展 size：需要再读 8 字节
              if (pos + 16 > data.byteLength) break; // 扩展 size 不完整，留到下次
              headerSize = 16;
              // 高 32 位（fMP4 场景下应为 0；>>> 0 确保无符号）
              const high = ((data[pos + 8] << 24) | (data[pos + 9] << 16) |
                           (data[pos + 10] << 8) | data[pos + 11]) >>> 0;
              const low = ((data[pos + 12] << 24) | (data[pos + 13] << 16) |
                          (data[pos + 14] << 8) | data[pos + 15]) >>> 0;
              boxSize = high * 0x100000000 + low;
            } else if (size === 0) {
              // size===0：box 延伸到文件末尾，剩余所有数据都是这个 box 的内容
              consumeEnd = data.byteLength;
              break;
            } else {
              boxSize = size;
            }

            if (boxSize < headerSize) {
              throw new Error(
                `非法 box size ${boxSize}（小于 header ${headerSize}）at offset ${dataOffset + pos}`
              );
            }

            const boxEnd = pos + boxSize;
            if (boxEnd > data.byteLength) break; // box 不完整，留到下次

            pos = boxEnd;
            consumeEnd = boxEnd;
          }

          // 3. 喂入完整的 box 数据给 mp4box
          if (consumeEnd > 0) {
            const completeData = data.subarray(0, consumeEnd);
            const ab = completeData.buffer.slice(
              completeData.byteOffset,
              completeData.byteOffset + completeData.byteLength
            );
            ab.fileStart = dataOffset;
            nextFileStart = dataOffset + consumeEnd;
            file.appendBuffer(ab);

            // 卡死检测（保留原有兜底逻辑）
            const curBoxPos = file.lastBoxStartPosition;
            if (curBoxPos === lastKnownBoxPos) {
              stalledExtraBytes += ab.byteLength;
              if (stalledExtraBytes > STALL_THRESHOLD_BYTES) {
                throw new Error(
                  `mp4box 解析卡死：box 位置 ${curBoxPos} 长期无法前进，` +
                  `已喂入 ${(stalledExtraBytes / 1024 / 1024).toFixed(1)}MB 新数据仍无进展，` +
                  `可能是 mp4box.js 的 box 边界/尺寸计算异常导致解析器永久卡死`
                );
              }
            } else {
              lastKnownBoxPos = curBoxPos;
              stalledExtraBytes = 0;
            }
          }

          // 4. 保存不完整的尾部（用 slice 创建副本，避免引用大 buffer 导致内存泄漏）
          if (consumeEnd < data.byteLength) {
            alignBuffer = {
              data: data.slice(consumeEnd),
              fileStart: dataOffset + consumeEnd,
            };
          }

          // 5. 更新 nextFileStart（不传 fileStart 的场景）
          if (fileStart == null && consumeEnd === 0) {
            // 全部进了残余缓冲，nextFileStart 保持不变（= baseOffset）
            // 下次调用会从 alignBuffer.fileStart 拼接
          }
        },
        flush() {
          // flush 时如果有残余缓冲（最后一个 box 可能不完整），也喂给 mp4box
          // fMP4 流的正常情况下最后一块数据应该是完整的，但兜底处理
          if (alignBuffer && alignBuffer.data.byteLength > 0) {
            const ab = alignBuffer.data.buffer.slice(
              alignBuffer.data.byteOffset,
              alignBuffer.data.byteOffset + alignBuffer.data.byteLength
            );
            ab.fileStart = alignBuffer.fileStart;
            file.appendBuffer(ab);
            alignBuffer = null;
          }
          file.flush();
        },
      });
    };

    // 喂入 init segment，fileStart=0
    // onReady 在这个 appendBuffer 内部同步触发
    const ab = initSegment.buffer.slice(
      initSegment.byteOffset,
      initSegment.byteOffset + initSegment.byteLength
    );
    ab.fileStart = 0;
    nextFileStart = ab.byteLength;
    file.appendBuffer(ab);
  });
}

// ─── 多帧合并 fragment（修 PIPELINE_ERROR_DECODE 用） ──────────────────
// 背景：mp4box.addSample 每次调用产生一个单样本 moof+mdat，几十万 sample
// 就有几十万个微小 fragment。Chromium 解码管线在极端分片密度下偶发
// PIPELINE_ERROR_DECODE（实测在 6 小时长视频的 6639.955 秒处必现）。
// 修复：攒够 N 个 sample 后用 createMultiSampleMoof 生成一个多样本 fragment，
// 分片密度跟源流一致（约 240 帧/fragment），从根上消除问题。

/** 每批 sample 数量，对齐源流 fragment 密度（约 5.57 秒/fragment @ 44100Hz） */
const BATCH_SAMPLE_SIZE = 240;

/**
 * 构造一个多样本 moof+mdat 并写入 output ISOFile
 *
 * 复用 mp4box.js 内部 BoxParser.moofBox/tfhd/tfdt/trun 的 box 类
 * （跟 createSingleSampleMoof 同一套原语，只是把单值字段换成长度为 N 的数组）
 *
 * @param {Object} isoFile - mp4box ISOFile（output）
 * @param {number} trackId - 输出 track id
 * @param {Array<{dts: number, cts: number, duration: number, is_sync: boolean, data: Uint8Array}>} samples
 *   本次 fragment 内的所有 sample（长度 >= 1）
 */
function createMultiSampleMoof(isoFile, trackId, samples) {
  const BoxParser = window.BoxParser;
  const track = isoFile.getTrackById(trackId);
  const moof = new BoxParser.moofBox();

  // mfhd：fragment 序号
  moof.add('mfhd').set('sequence_number', isoFile.nextMoofNumber);
  isoFile.nextMoofNumber++;

  const traf = moof.add('traf');

  // tfhd：track 头
  traf.add('tfhd')
    .set('track_id', trackId)
    .set('flags', BoxParser.TFHD_FLAG_DEFAULT_BASE_IS_MOOF);

  // tfdt：本 fragment 第一个 sample 的 DTS（相对于 track.first_dts）
  // ⚠️ 关键坑：track.first_dts 必须在第一批 sample 处理前就显式设置
  // （在 createBatchedSampleWriter 里设置），否则第一个 fragment 用绝对值、
  // 后面用相对值，整个文件时间基准会跳变
  traf.add('tfdt').set('baseMediaDecodeTime', samples[0].dts - (track.first_dts || 0));

  // trun：sample 表（duration/size/flags/cts_offset 都是长度为 N 的数组）
  const trun = traf.add('trun');
  trun
    .set('flags', BoxParser.TRUN_FLAGS_DATA_OFFSET
      | BoxParser.TRUN_FLAGS_DURATION
      | BoxParser.TRUN_FLAGS_SIZE
      | BoxParser.TRUN_FLAGS_FLAGS
      | BoxParser.TRUN_FLAGS_CTS_OFFSET)
    .set('data_offset', 0) // 占位，computeSize 后回填
    .set('first_sample_flags', 0)
    .set('sample_count', samples.length)
    .set('sample_duration', samples.map(s => s.duration))
    .set('sample_size', samples.map(s => s.size || s.data.byteLength))
    .set('sample_flags', samples.map(s => s.is_sync ? (1 << 25) : 65536))
    .set('sample_composition_time_offset', samples.map(s => s.cts - s.dts));

  isoFile.addBox(moof);
  moof.computeSize();

  // data_offset = moof.size + 8（mdat box 头 8 字节）
  // 表示第一个 sample 数据相对于 moof 起始位置的偏移
  moof.trafs[0].truns[0].data_offset = moof.size + 8;

  // 拼接所有 sample 数据到一个连续的 mdat
  const totalLen = samples.reduce((a, s) => a + s.data.byteLength, 0);
  const buf = new Uint8Array(totalLen);
  let off = 0;
  for (const s of samples) {
    buf.set(s.data, off);
    off += s.data.byteLength;
  }
  isoFile.add('mdat').data = buf;

  // 维护 track 累计统计（finalizeMp4Metadata 的 duration 计算可能依赖）
  track.samples_size = (track.samples_size || 0) + totalLen;
  track.samples_duration =
    (track.samples_duration || 0) + samples.reduce((a, s) => a + s.duration, 0);
}

/**
 * 创建一个批量化 sample 写入器
 *
 * 替代"每 sample 立即 addSample"的模式：内部维护一个 sample 缓冲区，
 * 攒满后调 createMultiSampleMoof 生成一个多样本 fragment。
 * flush() 时把剩余的（凑不够一批的）sample 也 flush 出去。
 *
 * 同时用于 remuxMultiTrackMp4（DASH/HLS 分片合并）和 executeBilibiliTask
 * （B 站单 URL 流式下载），确保所有生产路径都走多帧合并 fragment。
 *
 * 两种切分策略：
 *   - 固定批量（音频）：攒满 BATCH_SAMPLE_SIZE 个就 flush。音频每帧独立可解码，
 *     不存在帧间依赖，固定批量安全。
 *   - GOP 边界切分（视频，gopAware:true）：遇到关键帧（is_sync=true）且当前
 *     batch 已达 BATCH_SAMPLE_SIZE 时才 flush，保证每个 fragment 从关键帧开始。
 *     视频帧间有参考依赖（P/B 帧依赖前面的 I 帧），如果 fragment 从非关键帧
 *     开始，后续帧依赖的参考帧被切到前一个 fragment，Chromium 解码管线会报
 *     PIPELINE_ERROR_DECODE。按 GOP 边界切分确保每个 fragment 自包含可解码。
 *
 * @param {Object} isoFile - mp4box ISOFile（output）
 * @param {number} trackId - 输出 track id
 * @param {{gopAware?: boolean}} [options] - gopAware:true 时按 GOP 边界切分（视频用）
 * @returns {{push(sample: Object): void, flush(): void}}
 */
export function createBatchedSampleWriter(isoFile, trackId, options = {}) {
  const { gopAware = false } = options;
  /** GOP 异常长时的保护上限（约 6.4 个 GOP @ GOP=150），防止内存积压 */
  const MAX_BATCH_SIZE = BATCH_SAMPLE_SIZE * 4;
  /** @type {Array<Object>} */
  let batch = [];
  /** @type {boolean} */
  let firstDtsSet = false;

  return {
    push(sample) {
      // 第一批 sample 进入前，显式设置 track.first_dts
      // （createMultiSampleMoof 的 tfdt 计算依赖它，懒加载会跳变）
      if (!firstDtsSet) {
        const track = isoFile.getTrackById(trackId);
        if (track) {
          track.first_dts = sample.dts;
        }
        firstDtsSet = true;
      }

      // GOP 边界切分（视频）：遇到关键帧且当前 batch 已达最小阈值 →
      // 先 flush 当前 batch（不含此关键帧），此关键帧开始新 batch。
      // 这样每个 fragment 都以关键帧开始，包含整数个 GOP。
      if (gopAware && sample.is_sync && batch.length >= BATCH_SAMPLE_SIZE) {
        createMultiSampleMoof(isoFile, trackId, batch);
        batch = [];
      }

      // ⚠️ 必须创建浅拷贝，不能直接 push 原始 sample 对象：
      // mp4box 的 getSample 返回的是 trak.samples[i] 本体（同一引用），
      // onSamples 返回后 createInputProcessor 会调用 releaseUsedSamples，
      // 后者逐个执行 sample.data = null。如果 batch 持有原始对象引用，
      // 攒批期间 data 会被置 null → createMultiSampleMoof 读 s.data.byteLength
      // 时崩溃。浅拷贝让 batch 持有独立的 data 引用，不受 releaseUsedSamples 影响。
      // （Uint8Array 本身由 GC 管理，只要 batch 持有引用就不会被回收）
      batch.push({
        dts: sample.dts,
        cts: sample.cts,
        duration: sample.duration,
        is_sync: sample.is_sync,
        data: sample.data,
      });

      if (gopAware) {
        // 保护上限：异常长 GOP（如 GOP > MAX_BATCH_SIZE）时强制 flush，
        // 即使不从关键帧开始。这是极端情况降级，正常 GOP 不会触发。
        if (batch.length >= MAX_BATCH_SIZE) {
          createMultiSampleMoof(isoFile, trackId, batch);
          batch = [];
        }
      } else {
        // 音频固定批量：攒满即 flush
        if (batch.length >= BATCH_SAMPLE_SIZE) {
          createMultiSampleMoof(isoFile, trackId, batch);
          batch = [];
        }
      }
    },
    flush() {
      if (batch.length > 0) {
        createMultiSampleMoof(isoFile, trackId, batch);
        batch = [];
      }
    },
  };
}

/** MP4 标准单位变换矩阵（16.16 定点数，最后一项是 2.30 定点数的 1.0） */
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/**
 * 修正输出 MP4 的容器级元数据 —— 必须在 output.write() 之前调用
 *
 * mp4box.js 的 addTrack() 有几个硬编码或算错的默认值，会产出"能解析、但播放异常"
 * 的文件。这些字段【无法】通过 addTrack 的参数传入（源码里是写死的），只能事后
 * 直接改 box 对象。以下每一条都是 P3 实测复现并逐字节验证过的：
 *
 *   1. tkhd.matrix 被硬编码成全 0 [0,0,0,0,0,0,0,0,0]（同一个 init() 里给 mvhd
 *      设的反而是正确的单位矩阵，只有 tkhd 是错的）。全 0 是退化的显示变换矩阵：
 *      Chrome 会忽略它照常播放，但会真正应用该矩阵的播放器（VLC/MPC 等）会把画面
 *      剪切成倾斜的平行四边形。必须改回单位矩阵。
 *
 *   2. tkhd/mdhd/mvhd 的 duration 全是 0 —— fMP4 的 init segment 本身不带时长，
 *      透传进 addTrack 就是 0。播放器建不出 seek 表，表现为进度条无法拖动
 *      （Windows 自带播放器尤其明显）。用 addSample 累积出的 trak.samples_duration
 *      回填这三处。
 *
 *   3. mvhd.volume：init() 里 set 成 256，但 mvhd.write 里又 <<8 了一次 →
 *      65536 溢出 uint16 变成 0（即"静音"）。要存 1，write 时 <<8 得 256 = 1.0。
 *
 *   4. 音频轨道的 tkhd.width/height 被默认成 320x320（addTrack 里
 *      e.width = e.width||320，音频轨道不会传这两个值）。按规范音频轨道应为 0，
 *      否则播放器可能把它当成一个 320x320 的可视图层。
 *
 * 音视频轨道靠 mdia.hdlr.handler 区分（就是之前修掉"音频被标成 vide 导致完全没声音"
 * 那个字段），所以两条调用路径都不需要额外传 track id。
 *
 * 这些改动都不影响 box 长度（tkhd/mvhd/mdhd 的 write 里 size 是写死的常量），
 * 因此不需要重算任何 size。
 *
 * @param {Object} output - 输出 ISOFile（MP4Box.createFile() 的产物）
 */
export function finalizeMp4Metadata(output) {
  const moov = output?.moov;
  const mvhd = moov?.mvhd;
  if (!moov || !mvhd || !Array.isArray(moov.traks)) return;

  const movieTimescale = mvhd.timescale || 600;
  let maxMovieDuration = 0;

  for (const trak of moov.traks) {
    const tkhd = trak.tkhd;
    const mdhd = trak.mdia?.mdhd;
    if (!tkhd || !mdhd) continue;

    tkhd.matrix = IDENTITY_MATRIX.slice();

    // samples_duration 由 addSample 逐个累加而来，单位是该轨道的 mdhd.timescale
    const mediaDuration = trak.samples_duration || 0;
    const trackTimescale = mdhd.timescale || movieTimescale;
    mdhd.duration = mediaDuration;

    const movieDuration = Math.round(mediaDuration * movieTimescale / trackTimescale);
    tkhd.duration = movieDuration;
    if (movieDuration > maxMovieDuration) maxMovieDuration = movieDuration;

    if (trak.mdia?.hdlr?.handler === 'soun') {
      tkhd.width = 0;
      tkhd.height = 0;
      tkhd.volume = 1; // write 时 <<8 → 256 = 满音量
    } else {
      tkhd.volume = 0; // 规范：非音频轨道 volume 为 0
    }
  }

  mvhd.duration = maxMovieDuration;
  mvhd.volume = 1; // 见上方第 3 条：这里必须是 1，不是 256
  mvhd.matrix = IDENTITY_MATRIX.slice();
}

/**
 * 多轨道 fMP4 合并（mp4box.js）
 *
 * 用于 DASH 等场景：video 和 audio 是独立的 fMP4 流，需要交织进同一个 MP4 容器。
 *
 * 流程（基于 mp4box.js 官方 multitracks 示例）：
 *   1. 创建输出 ISOFile，根据 video/audio 的 track 信息 addTrack
 *   2. 为 video 和 audio 各创建一个输入 ISOFile（因为它们有各自的 init segment）
 *   3. 输入 ISOFile 的 onSamples 回调把 samples 通过 addSample 写入输出 ISOFile
 *   4. 逐个 fragment appendBuffer（fileStart 累计）触发 onSamples
 *   5. write(DataStream) 序列化输出，分块写入 FileWriter
 *
 * 内存约束：samples 逐 fragment 提取并立即添加到输出文件，不保留所有 fragment 的原始数据。
 *   但 addSample 内部会累积所有 sample 数据直到 write()，这是 mp4box.js 的固有限制。
 *   对于多轨道场景（主要是 DASH），这是可接受的——单轨道走 concatFmp4Stream 不经过 mp4box。
 *
 * @param {Object} params
 * @param {TrackInput} params.video - 视频轨道
 * @param {TrackInput} [params.audio] - 音频轨道
 * @param {Object} params.writer - FileWriter 实例
 * @param {(progress: number) => void} [onProgress] - 0-1
 * @returns {Promise<{method: 'fast', duration: number}>}
 */
export async function remuxMultiTrackMp4({ video, audio, writer, onProgress }) {
  await loadMp4box();
  const MP4Box = window.MP4Box;
  if (!MP4Box) throw new Error('mp4box 未加载');

  // ── 1. 创建输出 ISOFile ──
  const output = MP4Box.createFile();
  /** @type {number|null} */
  let outputVideoTrackId = null;
  /** @type {number|null} */
  let outputAudioTrackId = null;
  /** @type {Object|null} */
  let videoTrackInfo = null;
  /** @type {Object|null} */
  let audioTrackInfo = null;

  // ── 2. 创建 video 输入处理器 ──
  // onSamples 回调：用 batchedWriter 攒批写入，避免单样本 fragment 引发的
  // PIPELINE_ERROR_DECODE（见 createMultiSampleMoof 注释）
  /** @type {{push(s: Object): void, flush(): void}|null} */
  let videoWriter = null;
  const videoInputPromise = createInputProcessor(video.initSegment, (samples) => {
    // videoWriter 在 addTrack 后才创建，但 onSamples 在 appendFragment 时才触发，
    // 时序上 videoWriter 此时一定已就绪
    for (const sample of samples) {
      videoWriter.push(sample);
    }
  });

  // 等待 onReady（同步在 appendBuffer(initSegment) 内触发）
  const videoProcessor = await videoInputPromise;
  videoTrackInfo = videoProcessor.info.tracks.find((t) => t.type === 'video' || t.video);
  if (!videoTrackInfo) throw new Error('video init segment 中未找到视频轨道');

  // 现在知道了 video track 信息，可以在输出文件中 addTrack
  //
  // 关键修复（P3 实测）：必须把源 sample entry 的子 box（avcC/hvcC/av1C 等
  // 解码器配置盒）通过 description_boxes 原样搬过去。mp4box.js 的 addTrack()
  // 不会从 codec 字符串重建这些配置盒——avc1 无 avcC → 无 SPS/PPS，mp4a 无
  // esds → AAC 解码器无法初始化 → 静音。这是 mp4box 自己内部也是这么做的
  // （见 itemToFragmentedTrackFile 中的 description_boxes: i.properties.boxes）。
  //
  // type 字段优先用源 entry 的 type（权威值，如 "avc1"），找不到时降级到
  // codec.split('.')[0] 的猜测值。
  const videoSrcEntry = videoProcessor.getSampleEntry(videoTrackInfo.id);
  const videoFourCc = (videoTrackInfo.codec || video.codecs || 'avc1').split('.')[0];
  outputVideoTrackId = output.addTrack({
    type: videoSrcEntry?.type || videoFourCc,
    timescale: videoTrackInfo.timescale || video.timescale || 90000,
    duration: videoTrackInfo.duration || 0,
    width: videoTrackInfo.video?.width,
    height: videoTrackInfo.video?.height,
    codec: videoTrackInfo.codec,
    samples_duration: videoTrackInfo.samples_duration,
    samples_size: videoTrackInfo.samples_size,
    bitrate: videoTrackInfo.bitrate,
    language: videoTrackInfo.language,
    description_boxes: videoSrcEntry?.boxes,
    // 显式传 hdlr：见下方 audio 的注释，addTrack() 默认 handler 是 'vide'
    hdlr: 'vide',
    name: 'VideoHandler',
  });
  // trackId 已知，创建 batchedWriter（必须在喂入 fragments 之前）
  // 视频用 GOP 边界切分，确保每个 fragment 从关键帧开始
  videoWriter = createBatchedSampleWriter(output, outputVideoTrackId, { gopAware: true });

  // ── 3. 创建 audio 输入处理器（如果有） ──
  /** @type {{info: Object, appendFragment: (d: Uint8Array) => void, flush: () => void}|null} */
  let audioProcessor = null;
  /** @type {{push(s: Object): void, flush(): void}|null} */
  let audioWriter = null;
  if (audio && audio.initSegment) {
    const audioInputPromise = createInputProcessor(audio.initSegment, (samples) => {
      for (const sample of samples) {
        audioWriter.push(sample);
      }
    });

    audioProcessor = await audioInputPromise;
    audioTrackInfo = audioProcessor.info.tracks.find((t) => t.type === 'audio' || t.audio);
    if (audioTrackInfo) {
      // 同上 video：把源 sample entry 的 esds 等配置盒原样搬过去，否则 AAC 无 esds → 静音
      const audioSrcEntry = audioProcessor.getSampleEntry(audioTrackInfo.id);
      const audioFourCc = (audioTrackInfo.codec || audio.codecs || 'mp4a').split('.')[0];
      // 关键修复（真正的静音根因，P3 实测排查确认）：
      // 1. addTrack() 的 hdlr 参数默认值是 "vide"（对视频轨道凑巧对）。
      //    音频轨道若不显式传 hdlr:'soun'，其 moov/trak/mdia/hdlr 的
      //    handler_type 会被静默写成 "vide"，播放器据此把音频轨道当视频轨道
      //    处理，从不路由到音频输出——采样数据本身完全正确（用
      //    decodeAudioData 直接解码验证过是真实音频），只是从未发声。
      // 2. samplerate/channel_count 同理必须显式传，否则 fallback 成
      //    65536（16.16 定点数溢出后实际写出 0Hz）和默认 2。
      outputAudioTrackId = output.addTrack({
        type: audioSrcEntry?.type || audioFourCc,
        timescale: audioTrackInfo.timescale || audio.timescale || 48000,
        duration: audioTrackInfo.duration || 0,
        codec: audioTrackInfo.codec,
        samples_duration: audioTrackInfo.samples_duration,
        samples_size: audioTrackInfo.samples_size,
        bitrate: audioTrackInfo.bitrate,
        language: audioTrackInfo.language,
        description_boxes: audioSrcEntry?.boxes,
        samplerate: audioTrackInfo.audio ? audioTrackInfo.audio.sample_rate : undefined,
        channel_count: audioTrackInfo.audio ? audioTrackInfo.audio.channel_count : undefined,
        samplesize: audioTrackInfo.audio ? audioTrackInfo.audio.sample_size : undefined,
        hdlr: 'soun',
        name: 'SoundHandler',
      });
      audioWriter = createBatchedSampleWriter(output, outputAudioTrackId);
    }
  }

  // ── 4. 逐个 fragment 喂入输入处理器 ──
  // appendBuffer 内部会同步触发 onSamples，samples 立即被 addSample 到输出文件
  const totalFragments = video.segments.length + (audio ? audio.segments.length : 0);
  let processedFragments = 0;

  for (const seg of video.segments) {
    videoProcessor.appendFragment(seg.data);
    processedFragments++;
    if (onProgress) onProgress(processedFragments / totalFragments);
  }
  videoProcessor.flush();

  if (audioProcessor && audio) {
    for (const seg of audio.segments) {
      audioProcessor.appendFragment(seg.data);
      processedFragments++;
      if (onProgress) onProgress(processedFragments / totalFragments);
    }
    audioProcessor.flush();
  }

  // ── 5. 用 DataStream 序列化输出 ──
  // 注意：DataStream 是独立全局变量，不挂在 MP4Box 下
  finalizeMp4Metadata(output);
  const stream = new DataStream();
  stream.endianness = DataStream.BIG_ENDIAN;
  output.write(stream);

  const outputBuffer = stream.buffer;
  const outputData = new Uint8Array(outputBuffer);

  // ── 6. 分块写入 FileWriter ──
  const CHUNK_SIZE = 1024 * 1024; // 1MB
  let offset = 0;
  while (offset < outputData.length) {
    const end = Math.min(offset + CHUNK_SIZE, outputData.length);
    const chunk = outputData.subarray(offset, end);
    await writer.write(chunk, offset);
    offset = end;
  }

  return {
    method: 'fast',
    duration: Math.max(
      (videoTrackInfo.duration || 0) / (videoTrackInfo.timescale || 1),
      audioTrackInfo ? (audioTrackInfo.duration || 0) / (audioTrackInfo.timescale || 1) : 0
    ),
    // 暴露输出数据供调用方做自检（回灌 mp4box 验证配置盒）
    outputData,
  };
}

// ─── 向后兼容的旧接口（已废弃，保留导出避免 import 错误） ──

/**
 * @deprecated 使用 concatFmp4Stream 或 remuxMultiTrackMp4 代替
 */
export async function remuxToMp4(params) {
  if (params.audio) {
    return remuxMultiTrackMp4(params);
  }
  // 单轨道退化：用 concatFmp4Stream 语义
  throw new Error('单轨道请使用 concatFmp4Stream，多轨道请使用 remuxMultiTrackMp4');
}

// ─── 诊断工具（PIPELINE_ERROR_DECODE 根因定位用，非生产路径） ──
// 用法：在 offscreen console 或诊断脚本中调用
//   import { remuxSingleTrackForDiag, compareInputOutputBytes, compareWithSourceStream } from './remuxer.js'
// 所有诊断函数只在开关开启时记录数据，避免影响正常下载性能
// 开启方式：chrome.storage.local.set({webgrabDiag: true})

/**
 * 计算数据的 md5 哈希（轻量版，用 SubtleCrypto SHA-1 替代避免引入 md5 库）
 * 返回前 16 个字符的 hex，足够做唯一性对比
 * @param {Uint8Array} data
 * @returns {Promise<string>}
 */
async function hashData(data) {
  // SubtleCrypto 不支持 md5，用 SHA-1 替代（诊断用途，碰撞概率足够低）
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

/**
 * 截段复现诊断：只处理源流的指定时间范围，用现有 remux 流程跑一遍
 *
 * 用途：避免每次都跑完整长视频下载（几十分钟），只截取故障时间点附近的一小段
 * 音频流，用同样的 createInputProcessor + addSample 流程单独跑，看输出是否在
 * 该 sample 上出问题。
 *
 * @param {Object} params
 * @param {Uint8Array} params.initSegment - 音频 init segment
 * @param {Uint8Array[]} params.fragments - 音频 fragments 数组（按顺序）
 * @param {number} [params.targetSampleDts] - 目标 sample 的 DTS（用于标记）
 * @param {boolean} [params.recordHashes=false] - 是否记录每个 sample 的 input/output hash
 * @returns {Promise<{outputData: Uint8Array, sampleCount: number, hashMismatches: Array, sampleHashes: Array}>}
 */
export async function remuxSingleTrackForDiag({
  initSegment,
  fragments,
  targetSampleDts,
  recordHashes = false,
}) {
  const MP4Box = window.MP4Box;
  if (!MP4Box) throw new Error('mp4box 未加载');

  /** @type {Array<{index: number, dts: number, size: number, data: Uint8Array}>} */
  const inputSamples = [];
  let sampleIndex = 0;

  // 创建 input processor
  // ⚠️ 关键：onSamples 回调必须同步完成所有工作
  // mp4box.js 内部 onSamples 是同步 fire-and-forget，不 await Promise
  // 如果用 async 回调，每批 samples 里只有第一个被处理，其余静默丢失
  // 所以这里只同步收集 sample.data（独立副本），hash 计算移到 flush 后
  const realProcessor = await createInputProcessor(initSegment, (samples) => {
    for (const sample of samples) {
      if (recordHashes) {
        // 立即拷贝一份 sample.data（不持有 input 侧 buffer 引用）
        inputSamples.push({
          index: sampleIndex,
          dts: sample.dts,
          size: sample.data.byteLength,
          data: new Uint8Array(sample.data),
        });
      }
      sampleIndex++;
    }
  });

  const trackInfo = realProcessor.info.tracks[0];
  const output = MP4Box.createFile();
  const outputTrackId = output.addTrack({
    type: trackInfo.type || (trackInfo.audio ? 'soun' : 'vide'),
    timescale: trackInfo.timescale,
    duration: trackInfo.duration || 0,
    codec: trackInfo.codec,
    description_boxes: realProcessor.getSampleEntry(trackInfo.id)?.boxes,
    hdlr: trackInfo.audio ? 'soun' : 'vide',
  });

  // 喂入 fragments，触发 onSamples
  for (const frag of fragments) {
    realProcessor.appendFragment(frag);
  }
  realProcessor.flush();

  // ── flush 之后，异步计算 input hash ──
  /** @type {Array<{index: number, dts: number, inputHash: string, outputHash: string}>} */
  const sampleHashes = [];
  /** @type {Array<{index: number, dts: number, inputHash: string, outputHash: string}>} */
  const hashMismatches = [];

  if (recordHashes) {
    for (const s of inputSamples) {
      const inputHash = await hashData(s.data);
      sampleHashes.push({
        index: s.index,
        dts: s.dts,
        inputHash,
        outputHash: '', // write 后回扫时填
      });
    }
  }

  // 序列化 output
  finalizeMp4Metadata(output);
  const stream = new DataStream();
  stream.endianness = DataStream.BIG_ENDIAN;
  output.write(stream);
  const outputData = new Uint8Array(stream.buffer);

  // 回扫：解析 outputData，提取每个 sample 的字节，计算 output hash
  if (recordHashes && sampleHashes.length > 0) {
    const verifyFile = MP4Box.createFile();
    const verifyAb = outputData.buffer.slice(outputData.byteOffset, outputData.byteOffset + outputData.byteLength);
    verifyAb.fileStart = 0;
    verifyFile.appendBuffer(verifyAb);

    // 回扫的 onSamples 也必须同步收集，hash 异步计算在收集完后做
    /** @type {Array<{index: number, data: Uint8Array}>} */
    const outputSamples = [];
    let verifyIdx = 0;
    verifyFile.onSamples = (_trackId, _user, samples) => {
      for (const s of samples) {
        outputSamples.push({ index: verifyIdx, data: new Uint8Array(s.data) });
        verifyIdx++;
      }
    };
    for (const t of verifyFile.getTracks()) {
      verifyFile.setExtractionOptions(t.id, null);
    }
    verifyFile.start();
    // 重新 appendBuffer 触发 onSamples（mp4box 有时需要二次触发）
    const reAb = outputData.buffer.slice(outputData.byteOffset, outputData.byteOffset + outputData.byteLength);
    reAb.fileStart = 0;
    verifyFile.appendBuffer(reAb);

    // 异步计算 output hash 并对比
    for (const os of outputSamples) {
      if (os.index < sampleHashes.length) {
        const outputHash = await hashData(os.data);
        sampleHashes[os.index].outputHash = outputHash;
        if (sampleHashes[os.index].inputHash !== outputHash) {
          hashMismatches.push({
            index: os.index,
            dts: sampleHashes[os.index].dts,
            inputHash: sampleHashes[os.index].inputHash,
            outputHash,
          });
        }
      }
    }
  }

  return {
    outputData,
    sampleCount: sampleIndex,
    hashMismatches,
    sampleHashes,
    targetSampleDts,
  };
}

/**
 * input/output 字节对比诊断：在正常 remuxMultiTrackMp4 流程中注入 hash 记录
 *
 * 用法：包装 remuxMultiTrackMp4 的 onSamples 回调，记录每个 audio sample 的
 * input hash，remux 完成后回扫 output 文件计算对应 sample 的 output hash，
 * 对比找出哪个 sample 的字节被改了。
 *
 * @param {Object} params - 同 remuxMultiTrackMp4 的参数
 * @param {number} [params.diagTrackType='audio'] - 'audio' | 'video'，记录哪个轨道
 * @param {number} [params.diagStartDts] - 只记录 DTS >= 此值的 sample（节省内存）
 * @returns {Promise<{result: Object, diagReport: Object}>}
 *   result: remuxMultiTrackMp4 的正常返回值
 *   diagReport: { sampleHashes, hashMismatches, totalSamples }
 */
export async function compareInputOutputBytes(params) {
  // ⚠️ 这是诊断专用代码，不用于生产路径，不做错误处理优化
  const MP4Box = window.MP4Box;
  if (!MP4Box) throw new Error('mp4box 未加载');

  const { video, audio, writer, diagTrackType = 'audio', diagStartDts } = params;

  /**
   * 同步收集的 input sample 副本（onSamples 里立即拷贝，避免 async 导致 samples 丢失）
   * @type {Array<{index: number, dts: number, size: number, data: Uint8Array}>}
   */
  const inputSamples = [];
  let sampleIndex = 0;

  const output = MP4Box.createFile();
  let outputVideoTrackId, outputAudioTrackId;

  // ⚠️ 关键修复：onSamples 回调必须同步完成所有工作
  // mp4box.js 的 onSamples 是同步 fire-and-forget，不 await Promise
  // 旧版用 async 回调 + await hashData，每批 samples 只有第一个被处理，其余丢失
  // 修复：回调保持同步，立即拷贝 sample.data，hash 计算移到 flush 后
  const audioInputPromise = createInputProcessor(audio.initSegment, (samples) => {
    for (const sample of samples) {
      if (diagStartDts != null && sample.dts < diagStartDts) {
        output.addSample(outputAudioTrackId, sample.data, {
          duration: sample.duration,
          dts: sample.dts,
          cts: sample.cts,
          is_sync: sample.is_sync,
        });
        continue;
      }

      // 同步收集：立即拷贝 data 副本
      inputSamples.push({
        index: sampleIndex,
        dts: sample.dts,
        size: sample.data.byteLength,
        data: new Uint8Array(sample.data),
      });

      output.addSample(outputAudioTrackId, sample.data, {
        duration: sample.duration,
        dts: sample.dts,
        cts: sample.cts,
        is_sync: sample.is_sync,
      });
      sampleIndex++;
    }
  });

  const videoInputPromise = createInputProcessor(video.initSegment, (samples) => {
    for (const sample of samples) {
      output.addSample(outputVideoTrackId, sample.data, {
        duration: sample.duration,
        dts: sample.dts,
        cts: sample.cts,
        is_sync: sample.is_sync,
      });
    }
  });

  const videoProcessor = await videoInputPromise;
  const videoTrackInfo = videoProcessor.info.tracks.find((t) => t.type === 'video' || t.video);
  const videoSrcEntry = videoProcessor.getSampleEntry(videoTrackInfo.id);
  const videoFourCc = (videoTrackInfo.codec || video.codecs || 'avc1').split('.')[0];
  outputVideoTrackId = output.addTrack({
    type: videoSrcEntry?.type || videoFourCc,
    timescale: videoTrackInfo.timescale || video.timescale || 90000,
    duration: videoTrackInfo.duration || 0,
    width: videoTrackInfo.video?.width,
    height: videoTrackInfo.video?.height,
    codec: videoTrackInfo.codec,
    description_boxes: videoSrcEntry?.boxes,
    hdlr: 'vide',
    name: 'VideoHandler',
  });

  const audioProcessor = await audioInputPromise;
  const audioTrackInfo = audioProcessor.info.tracks.find((t) => t.type === 'audio' || t.audio);
  const audioSrcEntry = audioProcessor.getSampleEntry(audioTrackInfo.id);
  const audioFourCc = (audioTrackInfo.codec || audio.codecs || 'mp4a').split('.')[0];
  outputAudioTrackId = output.addTrack({
    type: audioSrcEntry?.type || audioFourCc,
    timescale: audioTrackInfo.timescale || audio.timescale || 44100,
    duration: audioTrackInfo.duration || 0,
    codec: audioTrackInfo.codec,
    description_boxes: audioSrcEntry?.boxes,
    hdlr: 'soun',
    name: 'SoundHandler',
  });

  // 喂入 fragments
  for (const seg of video.segments) {
    videoProcessor.appendFragment(seg.data);
  }
  videoProcessor.flush();

  for (const seg of audio.segments) {
    audioProcessor.appendFragment(seg.data);
  }
  audioProcessor.flush();

  // ── flush 后，异步计算 input hash ──
  /** @type {Array<{index: number, dts: number, size: number, inputHash: string}>} */
  const sampleHashes = [];
  for (const s of inputSamples) {
    const inputHash = await hashData(s.data);
    sampleHashes.push({
      index: s.index,
      dts: s.dts,
      size: s.size,
      inputHash,
    });
  }

  // 序列化 output
  finalizeMp4Metadata(output);
  const stream = new DataStream();
  stream.endianness = DataStream.BIG_ENDIAN;
  output.write(stream);
  const outputData = new Uint8Array(stream.buffer);

  // 分块写入
  const CHUNK_SIZE = 1024 * 1024;
  let offset = 0;
  while (offset < outputData.length) {
    const end = Math.min(offset + CHUNK_SIZE, outputData.length);
    await writer.write(outputData.subarray(offset, end), offset);
    offset = end;
  }

  // 回扫 output 文件，同步收集 output samples
  /** @type {Array<{index: number, data: Uint8Array}>} */
  const outputSamples = [];
  const verifyFile = MP4Box.createFile();
  const verifyAb = outputData.buffer.slice(outputData.byteOffset, outputData.byteOffset + outputData.byteLength);
  verifyAb.fileStart = 0;
  verifyFile.appendBuffer(verifyAb);

  // 同步收集 output samples
  let verifyIdx = 0;
  verifyFile.onSamples = (_trackId, _user, samples) => {
    for (const s of samples) {
      if (_trackId === outputAudioTrackId || audioTrackInfo.id === _trackId) {
        outputSamples.push({ index: verifyIdx, data: new Uint8Array(s.data) });
      }
      verifyIdx++;
    }
  };
  for (const t of verifyFile.getTracks()) {
    verifyFile.setExtractionOptions(t.id, null);
  }
  verifyFile.start();
  // 重新 appendBuffer 触发 sample 提取（mp4box 有时需要二次触发）
  const reAb = outputData.buffer.slice(outputData.byteOffset, outputData.byteOffset + outputData.byteLength);
  reAb.fileStart = 0;
  verifyFile.appendBuffer(reAb);

  // 异步计算 output hash 并对比
  /** @type {Array<{index: number, dts: number, size: number, inputHash: string, outputHash: string}>} */
  const hashMismatches = [];
  for (const os of outputSamples) {
    if (os.index < sampleHashes.length) {
      const outputHash = await hashData(os.data);
      if (sampleHashes[os.index].inputHash !== outputHash) {
        hashMismatches.push({
          index: sampleHashes[os.index].index,
          dts: sampleHashes[os.index].dts,
          size: sampleHashes[os.index].size,
          inputHash: sampleHashes[os.index].inputHash,
          outputHash,
        });
      }
    }
  }

  return {
    result: {
      method: 'fast',
      duration: Math.max(
        (videoTrackInfo.duration || 0) / (videoTrackInfo.timescale || 1),
        (audioTrackInfo.duration || 0) / (audioTrackInfo.timescale || 1)
      ),
      outputData,
    },
    diagReport: {
      totalSamples: sampleHashes.length,
      hashMismatches,
      sampleHashes: sampleHashes.slice(0, 100), // 只返回前 100 条避免数据过大
    },
  };
}

/**
 * 源流对比诊断：把源音频流的原始字节（init + fragments 拼接）直接写成文件，
 * 与 remux 后的文件做对比
 *
 * 用途：判断故障 sample 在源流里本身是否就有问题。如果源流直接播放也解码失败，
 * 说明是 B 站编码瑕疵；如果源流正常但 remux 后失败，说明是 remux 过程的问题。
 *
 * @param {Object} params
 * @param {Uint8Array} params.initSegment - 音频 init segment
 * @param {Uint8Array[]} params.fragments - 音频 fragments 数组
 * @returns {{sourceFile: Uint8Array, sampleCount: number}}
 */
export function compareWithSourceStream({ initSegment, fragments }) {
  // 源流就是 init + fragments 直接拼接（fMP4 单轨道）
  const totalSize = initSegment.byteLength + fragments.reduce((s, f) => s + f.byteLength, 0);
  const sourceFile = new Uint8Array(totalSize);
  let offset = initSegment.byteLength;
  sourceFile.set(initSegment, 0);
  for (const frag of fragments) {
    sourceFile.set(frag, offset);
    offset += frag.byteLength;
  }

  return {
    sourceFile,
    totalSize,
    fragmentCount: fragments.length,
  };
}
