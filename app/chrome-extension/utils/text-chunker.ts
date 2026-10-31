/**
 * Text chunking utility for semantic indexing.
 */
export interface TextChunk {
  text: string;
  source: string;
  index: number;
  wordCount: number;
}

export interface ChunkingOptions {
  maxWordsPerChunk?: number;
  overlapSentences?: number;
  minChunkLength?: number;
  includeTitle?: boolean;
}

export class TextChunker {
  private readonly defaultOptions: Required<ChunkingOptions> = {
    maxWordsPerChunk: 80,
    overlapSentences: 1,
    minChunkLength: 20,
    includeTitle: true,
  };

  public chunkText(content: string, title?: string, options?: ChunkingOptions): TextChunk[] {
    const opts = { ...this.defaultOptions, ...options };
    const chunks: TextChunk[] = [];
    if (opts.includeTitle && title?.trim() && title.trim().length > 5) {
      chunks.push({
        text: title.trim(),
        source: 'title',
        index: 0,
        wordCount: title.trim().split(/\s+/).length,
      });
    }
    const cleanContent = content.trim();
    if (!cleanContent) return chunks;
    const sentences = this.splitIntoSentences(cleanContent);
    if (sentences.length === 0) return this.fallbackChunking(cleanContent, chunks, opts);
    if (sentences.some((sentence) => sentence.split(/\s+/).length > opts.maxWordsPerChunk)) {
      return this.mixedChunking(sentences, chunks, opts);
    }
    return this.groupSentencesIntoChunks(sentences, chunks, opts);
  }

  private splitIntoSentences(content: string): string[] {
    const sentences = content
      .replace(/([。！？])\s*/g, '$1\n')
      .replace(/([.!?])\s+(?=[A-Z])/g, '$1\n')
      .replace(/([.!?]["'])\s+(?=[A-Z])/g, '$1\n')
      .replace(/([.!?])\s*$/gm, '$1\n')
      .replace(/([。！？][”"])\s*/g, '$1\n')
      .replace(/\n\s*\n/g, '\n')
      .split('\n')
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 15);
    return sentences.length < 3 && content.length > 500
      ? this.aggressiveSentenceSplitting(content)
      : sentences;
  }

  private aggressiveSentenceSplitting(content: string): string[] {
    const sentences = content
      .replace(/([.!?。！？])/g, '$1\n')
      .replace(/([;；:：])/g, '$1\n')
      .replace(/([)）])\s*(?=[\u4e00-\u9fa5A-Z])/g, '$1\n')
      .split('\n')
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 15);
    const result: string[] = [];
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      if (words.length <= 80) result.push(sentence);
      else
        for (let index = 0; index < words.length; index += 75) {
          const text = words.slice(index, index + 80).join(' ');
          if (text.length > 15) result.push(text);
        }
    }
    return result;
  }

  private groupSentencesIntoChunks(
    sentences: string[],
    existing: TextChunk[],
    options: Required<ChunkingOptions>,
  ): TextChunk[] {
    const chunks = [...existing];
    let chunkIndex = chunks.length;
    for (let index = 0; index < sentences.length; ) {
      let text = '';
      let wordCount = 0;
      let used = 0;
      while (index + used < sentences.length && wordCount < options.maxWordsPerChunk) {
        const sentence = sentences[index + used];
        const count = sentence.split(/\s+/).length;
        if (wordCount + count > options.maxWordsPerChunk && wordCount > 0) break;
        text += (text ? ' ' : '') + sentence;
        wordCount += count;
        used++;
      }
      if (text.trim().length > options.minChunkLength)
        chunks.push({
          text: text.trim(),
          source: `content_chunk_${chunkIndex}`,
          index: chunkIndex++,
          wordCount,
        });
      index += Math.max(1, used - options.overlapSentences);
    }
    return chunks;
  }

  private mixedChunking(
    sentences: string[],
    existing: TextChunk[],
    options: Required<ChunkingOptions>,
  ): TextChunk[] {
    const chunks = [...existing];
    let chunkIndex = chunks.length;
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      if (words.length <= options.maxWordsPerChunk) {
        chunks.push({
          text: sentence.trim(),
          source: `sentence_chunk_${chunkIndex}`,
          index: chunkIndex++,
          wordCount: words.length,
        });
        continue;
      }
      for (let index = 0; index < words.length; index += options.maxWordsPerChunk) {
        const text = words.slice(index, index + options.maxWordsPerChunk).join(' ');
        if (text.length > options.minChunkLength)
          chunks.push({
            text,
            source: `long_sentence_chunk_${chunkIndex}_part_${Math.floor(index / options.maxWordsPerChunk)}`,
            index: chunkIndex,
            wordCount: Math.min(options.maxWordsPerChunk, words.length - index),
          });
      }
      chunkIndex++;
    }
    return chunks;
  }

  private fallbackChunking(
    content: string,
    existing: TextChunk[],
    options: Required<ChunkingOptions>,
  ): TextChunk[] {
    const chunks = [...existing];
    let chunkIndex = chunks.length;
    const paragraphs = content
      .split(/\n\s*\n/)
      .filter((paragraph) => paragraph.trim().length > options.minChunkLength);
    const sources = paragraphs.length > 1 ? paragraphs : [content];
    for (let paragraphIndex = 0; paragraphIndex < sources.length; paragraphIndex++) {
      const words = sources[paragraphIndex].trim().split(/\s+/);
      for (let index = 0; index < words.length; index += 150) {
        const text = words.slice(index, index + 150).join(' ');
        if (text.length > options.minChunkLength)
          chunks.push({
            text,
            source:
              paragraphs.length > 1
                ? `paragraph_${paragraphIndex}_chunk_${Math.floor(index / 150)}`
                : `content_chunk_${Math.floor(index / 150)}`,
            index: chunkIndex++,
            wordCount: Math.min(150, words.length - index),
          });
      }
    }
    return chunks;
  }
}
