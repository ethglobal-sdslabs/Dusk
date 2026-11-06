import { describe, expect, it } from 'vitest'
import { bytesToBase64, classifyFile, textAttachment } from '../src/lib/attach'

describe('classifyFile', () => {
  it.each([
    ['cat.png', 'image/png', 'image'],
    ['cat.JPG', 'image/jpeg', 'image'],
    ['cat.webp', '', 'image'],
    ['notes.md', '', 'text'],
    ['data.csv', 'text/csv', 'text'],
    ['main.ts', 'video/mp2t', 'text'],
    ['config.json', 'application/json', 'text'],
    ['paper.pdf', 'application/pdf', 'pdf'],
    ['cat.gif', 'image/gif', 'unsupported'],
    ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'unsupported'],
    ['archive.zip', 'application/zip', 'unsupported'],
  ])('%s (%s) is %s', (name, type, want) => {
    expect(classifyFile(name, type)).toBe(want)
  })
})

describe('textAttachment', () => {
  it('decodes UTF-8 text', () => {
    expect(textAttachment('a.md', new TextEncoder().encode('# héllo'))).toEqual({ kind: 'text', name: 'a.md', text: '# héllo' })
  })
  it('refuses bytes that are not UTF-8, naming the file', () => {
    expect(() => textAttachment('a.txt', new Uint8Array([0xff, 0xfe, 0x00, 0x41]))).toThrow(/a\.txt/)
  })
  it('refuses a binary file that happens to decode', () => {
    expect(() => textAttachment('a.txt', new Uint8Array([0x41, 0x00, 0x42]))).toThrow(/text/)
  })
})

describe('bytesToBase64', () => {
  it('matches btoa over a binary string, for bytes above 0x7f too', () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xff, 0x89, 0x50])
    expect(bytesToBase64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
  })
  it('handles a buffer larger than one argument list', () => {
    const bytes = new Uint8Array(200_000).fill(0x41)
    expect(bytesToBase64(bytes)).toBe(btoa('A'.repeat(200_000)))
  })
})
