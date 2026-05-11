// 真复现一下：改 master volume / reverb send 后保存，是否产生合法 JSON 工程文件
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectMixState, mergeProjectMixState } from '../src/host/project/projectMixState.js'
import { mergeTrackPlaybackState, createTrackPlaybackState } from '../src/host/project/trackPlaybackState.js'
import { serializeProject, deserializeProject } from '../src/host/project/projectFile.js'

function buildProject() {
  return {
    fileName: 'test.webutau',
    ppq: 480,
    tempoData: { tempos: [{ bpm: 120, time: 0, ticks: 0 }], timeSignatures: [{ ticks: 0, timeSignature: [4, 4] }] },
    mixState: createProjectMixState({}),
    selectedTrackId: 't1',
    editorTrackId: null,
    tracks: [
      {
        id: 't1',
        name: 'Track 1',
        kind: 'instrument',
        languageCode: null,
        color: '#3B8B88',
        notes: [],
        playbackState: createTrackPlaybackState({}, { reverbConfig: null }),
      },
    ],
  }
}

describe('修改 reverb send / master volume 后序列化', () => {
  it('改了 reverb send → serializeProject 产物可被 deserializeProject 解析', () => {
    const project = buildProject()
    project.tracks[0].playbackState = mergeTrackPlaybackState(
      project.tracks[0].playbackState,
      { reverbSend: 0.42 },
    )
    const jsonString = serializeProject({ project })
    // 这一步如果用户报的 bug 真存在，JSON.parse 会抛
    const round = deserializeProject(jsonString)
    assert.ok(round, 'deserializeProject 必须能正常返回')
    // 取出来的 reverbSend 应仍是 0.42
    const t1 = round.project?.tracks?.find?.((t) => t.id === 't1')
    assert.equal(t1?.playbackState?.reverbSend, 0.42)
  })

  it('改了 masterVolume → 序列化 / 反序列化 round-trip', () => {
    const project = buildProject()
    project.mixState = mergeProjectMixState(project.mixState, { masterVolume: 0.7 })
    const jsonString = serializeProject({ project })
    const round = deserializeProject(jsonString)
    assert.equal(round?.project?.mixState?.masterVolume, 0.7)
  })

  it('同时改 send + masterVolume', () => {
    const project = buildProject()
    project.mixState = mergeProjectMixState(project.mixState, { masterVolume: 0.6 })
    project.tracks[0].playbackState = mergeTrackPlaybackState(
      project.tracks[0].playbackState,
      { reverbSend: 0.55 },
    )
    const jsonString = serializeProject({ project })
    // 确认产物是有效 JSON 文本（含合法字符、无截断）
    assert.doesNotThrow(() => JSON.parse(jsonString))
  })
})
