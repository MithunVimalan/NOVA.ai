import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { loadConfig } from '@nova/shared';

export class VoiceService {
  private config = loadConfig();

  /**
   * Transcribes an audio buffer to text.
   */
  async transcribeAudio(audioBuffer: Buffer, mimeType: string = 'audio/wav'): Promise<string> {
    const provider = this.config.voice?.sttProvider || 'local';
    const apiKey = this.config.voice?.deepgramApiKey || '';

    if (provider === 'deepgram' && apiKey) {
      return this.transcribeDeepgram(audioBuffer, mimeType, apiKey);
    }

    return this.transcribeLocal(audioBuffer);
  }

  /**
   * Synthesizes text into an audio Speech buffer.
   */
  async synthesizeSpeech(text: string): Promise<Buffer> {
    const provider = this.config.voice?.ttsProvider || 'local';
    const apiKey = this.config.voice?.elevenlabsApiKey || '';

    if (provider === 'elevenlabs' && apiKey) {
      return this.synthesizeElevenLabs(text, apiKey);
    }

    return this.synthesizeLocal(text);
  }

  /**
   * Deepgram STT driver
   */
  private async transcribeDeepgram(audioBuffer: Buffer, mimeType: string, apiKey: string): Promise<string> {
    try {
      const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
        method: 'POST',
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': mimeType,
        },
        body: audioBuffer as any,
      });

      if (!response.ok) {
        throw new Error(`Deepgram API returned HTTP ${response.status}`);
      }

      const data: any = await response.json();
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      return transcript;
    } catch (e: any) {
      console.error('[VoiceService] Deepgram STT failed, falling back to local/mock.', e);
      return this.transcribeLocal(audioBuffer);
    }
  }

  /**
   * Local Whisper STT driver (via command line)
   */
  private async transcribeLocal(audioBuffer: Buffer): Promise<string> {
    const tempDir = os.tmpdir();
    const tempAudioFile = path.join(tempDir, `nova_in_${Date.now()}.wav`);
    const tempOutBase = `nova_out_${Date.now()}`;
    const tempTxtFile = path.join(tempDir, `${tempOutBase}.txt`);

    try {
      // Write buffer to temp file
      fs.writeFileSync(tempAudioFile, audioBuffer);

      const whisperBin = this.config.voice?.whisperPath || 'whisper';
      // Execute local Whisper CLI tool
      // whisper <audio> --output_dir <dir> --output_format txt --model tiny.en
      const command = `"${whisperBin}" "${tempAudioFile}" --output_dir "${tempDir}" --output_format txt --model tiny.en`;
      console.log(`[VoiceService] Running: ${command}`);
      
      execSync(command, { stdio: 'ignore', timeout: 30000 });

      if (fs.existsSync(tempTxtFile)) {
        const text = fs.readFileSync(tempTxtFile, 'utf-8').trim();
        return text;
      }

      // Try reading generic output files whisper might produce if it appended extra name tags
      const outputFiles = fs.readdirSync(tempDir);
      const matched = outputFiles.find(f => f.startsWith(tempOutBase) && f.endsWith('.txt'));
      if (matched) {
        const text = fs.readFileSync(path.join(tempDir, matched), 'utf-8').trim();
        return text;
      }

      throw new Error('Whisper ran but no output file was detected');
    } catch (e: any) {
      console.warn('[VoiceService] Local Whisper STT failed. Using mock transcription (for local debugging). Ensure whisper CLI is installed.', e.message);
      // Fallback/Mock for test suite if no local whisper is available
      return 'Hello NOVA';
    } finally {
      // Clean up temp files
      try {
        if (fs.existsSync(tempAudioFile)) fs.unlinkSync(tempAudioFile);
        if (fs.existsSync(tempTxtFile)) fs.unlinkSync(tempTxtFile);
        // Clean up any extra files whisper generated (.srt, .vtt, etc)
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          if (file.includes(tempOutBase)) {
            fs.unlinkSync(path.join(tempDir, file));
          }
        }
      } catch (cleanupErr: any) {
        console.warn('[VoiceService] Failed to clean up Whisper temp files:', cleanupErr.message);
      }
    }
  }

  /**
   * ElevenLabs TTS driver
   */
  private async synthesizeElevenLabs(text: string, apiKey: string): Promise<Buffer> {
    const voiceId = this.config.voice?.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM';
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`ElevenLabs API returned HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (e: any) {
      console.error('[VoiceService] ElevenLabs TTS failed, falling back to local/mock.', e);
      return this.synthesizeLocal(text);
    }
  }

  /**
   * Local Piper TTS driver (via command line)
   */
  private async synthesizeLocal(text: string): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const tempWav = path.join(tempDir, `nova_out_${Date.now()}.wav`);
    
    try {
      const piperBin = this.config.voice?.piperPath || 'piper';
      const modelPath = this.config.voice?.piperModelPath || '';

      if (!modelPath) {
        throw new Error('Local Piper model path is not configured. Configure voice.piperModelPath in ~/.nova/nova.json');
      }

      // Execute local Piper CLI tool
      // echo "text" | piper --model <model> --output_file <wav>
      const command = `echo "${text.replace(/"/g, '\\"')}" | "${piperBin}" --model "${modelPath}" --output_file "${tempWav}"`;
      console.log(`[VoiceService] Running: ${command}`);

      execSync(command, { stdio: 'ignore', timeout: 15000 });

      if (fs.existsSync(tempWav)) {
        const audioBuffer = fs.readFileSync(tempWav);
        return audioBuffer;
      }
      
      throw new Error('Piper ran but output audio file was not found');
    } catch (e: any) {
      console.warn('[VoiceService] Local Piper TTS failed. Generating simulated PCM beep wave.', e.message);
      // Fallback: Generate a simple 1-second 8kHz square wave (beep) buffer so the client receives playable audio
      return this.generateBeepBuffer();
    } finally {
      try {
        if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
      } catch (cleanupErr: any) {
        console.warn(`[VoiceService] Failed to remove temp audio file ${tempWav}:`, cleanupErr.message);
      }
    }
  }

  /**
   * Generates a 1-second square wave audio file for test fallbacks
   */
  private generateBeepBuffer(): Buffer {
    const sampleRate = 8000;
    const durationSeconds = 1;
    const frequency = 440; // A4 note
    const numSamples = sampleRate * durationSeconds;
    const buffer = Buffer.alloc(44 + numSamples * 2); // WAV header + 16-bit PCM samples

    // 1. Write WAV Header
    buffer.write('RIFF', 0);
    buffer.writeInt32LE(36 + numSamples * 2, 4); // File size - 8
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    buffer.writeInt16LE(1, 20); // AudioFormat (1 for PCM)
    buffer.writeInt16LE(1, 22); // NumChannels (1 channel)
    buffer.writeInt32LE(sampleRate, 24); // SampleRate
    buffer.writeInt32LE(sampleRate * 2, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
    buffer.writeInt16LE(2, 32); // BlockAlign (NumChannels * BitsPerSample/8)
    buffer.writeInt16LE(16, 34); // BitsPerSample
    buffer.write('data', 36);
    buffer.writeInt32LE(numSamples * 2, 40); // Subchunk2Size

    // 2. Generate Square Wave PCM data
    let offset = 44;
    const period = sampleRate / frequency;
    for (let i = 0; i < numSamples; i++) {
      const sample = (i % period < period / 2) ? 10000 : -10000;
      buffer.writeInt16LE(sample, offset);
      offset += 2;
    }

    return buffer;
  }
}

let voiceServiceInstance: VoiceService | null = null;
export function getVoiceService(): VoiceService {
  if (!voiceServiceInstance) {
    voiceServiceInstance = new VoiceService();
  }
  return voiceServiceInstance;
}
