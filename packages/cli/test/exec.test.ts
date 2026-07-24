import { describe, expect, it, vi } from 'vitest'
import { exec } from '../src/exec'

describe('exec', () => {
  it('captures stdout and stderr regardless of streaming', async () => {
    const result = await exec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'])
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.status).toBe(0)
  })

  it('does not write to the current process by default', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await exec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'])
      expect(stdoutSpy).not.toHaveBeenCalled()
      expect(stderrSpy).not.toHaveBeenCalled()
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })

  it('streams to the current process live when stream: true', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await exec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'], { stream: true })
      expect(stdoutSpy).toHaveBeenCalled()
      expect(stderrSpy).toHaveBeenCalled()
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })

  it('reports a non-zero exit status', async () => {
    const result = await exec(process.execPath, ['-e', 'process.exit(3)'])
    expect(result.status).toBe(3)
  })
})
