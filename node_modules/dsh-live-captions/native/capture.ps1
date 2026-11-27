#Requires -Version 5.1
<#
  Real-time audio capture helper for the live-captions plugin.

  Captures the Windows default *render* endpoint in loopback mode (what the
  speakers play) and/or the default *capture* endpoint (microphone), mixes them
  to 16 kHz mono 16-bit PCM and writes consecutive WAV segments to -OutDir.

  Protocol (stdout, one JSON object per line):
    {"type":"ready","outDir":"...","segmentSeconds":8}
    {"type":"segment","index":1,"file":"seg-000001.wav","seconds":4.0,"rms":0.0321}
    {"type":"error","error":"..."}

  The process exits when its parent terminates it or when the file
  "<OutDir>\stop.flag" appears.
#>
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$SegmentSeconds = 8,
  [double]$MinSegmentSeconds = 1.2,
  [ValidateSet('both', 'speaker', 'mic')][string]$Source = 'both',
  [int]$SampleRate = 16000
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

$csSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace DshAudio
{
    internal enum EDataFlow { Render = 0, Capture = 1, All = 2 }
    internal enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

    [Flags]
    internal enum CLSCTX : uint
    {
        INPROC_SERVER = 0x1, INPROC_HANDLER = 0x2, LOCAL_SERVER = 0x4,
        REMOTE_SERVER = 0x10, ALL = 0x17
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(uint access, out IntPtr store);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out uint state);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity,
                       IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out uint frameCount);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frameCount, out uint flags,
                      out long devicePosition, out long qpcPosition);
        int ReleaseBuffer(uint frameCount);
        int GetNextPacketSize(out uint frameCount);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    internal sealed class CaptureStream
    {
        public const uint LOOPBACK = 0x00020000;
        public const uint AUTOCONVERTPCM = 0x80000000;
        public const uint SRC_DEFAULT_QUALITY = 0x08000000;

        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

        public string Name;
        public IAudioClient Client;
        public IAudioCaptureClient Capture;
        public int NativeRate;
        public int Channels;
        public bool IsFloat;
        public bool IsLoopback;

        // resampler state (native -> 16 kHz)
        double position;
        float previous;

        public static CaptureStream Open(bool loopback, int targetRate)
        {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(loopback ? EDataFlow.Render : EDataFlow.Capture, ERole.Multimedia, out device);
            if (hr != 0) throw new COMException("no default endpoint", hr);

            object raw;
            Guid iidClient = IID_IAudioClient;
            hr = device.Activate(ref iidClient, CLSCTX.ALL, IntPtr.Zero, out raw);
            if (hr != 0) throw new COMException("Activate(IAudioClient) failed", hr);
            var client = (IAudioClient)raw;

            uint flags = loopback ? LOOPBACK : 0u;
            bool initialized = false;
            int rate = targetRate;
            int channels = 1;
            bool isFloat = false;

            // Preferred: let WASAPI convert to 16 kHz mono 16-bit PCM.
            var requested = new WAVEFORMATEX
            {
                wFormatTag = 1,
                nChannels = 1,
                nSamplesPerSec = (uint)targetRate,
                wBitsPerSample = 16,
                nBlockAlign = 2,
                nAvgBytesPerSec = (uint)(targetRate * 2),
                cbSize = 0
            };
            IntPtr requestedPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEFORMATEX)));
            try
            {
                Marshal.StructureToPtr(requested, requestedPtr, false);
                hr = client.Initialize(0, flags | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY, 2000000, 0, requestedPtr, IntPtr.Zero);
                initialized = hr == 0;
            }
            finally
            {
                Marshal.FreeHGlobal(requestedPtr);
            }

            if (!initialized)
            {
                IntPtr mixPtr;
                hr = client.GetMixFormat(out mixPtr);
                if (hr != 0) throw new COMException("GetMixFormat failed", hr);
                var mix = (WAVEFORMATEX)Marshal.PtrToStructure(mixPtr, typeof(WAVEFORMATEX));
                rate = (int)mix.nSamplesPerSec;
                channels = mix.nChannels;
                isFloat = mix.wBitsPerSample == 32;
                if (mix.wFormatTag == 0xFFFE)
                {
                    // WAVEFORMATEXTENSIBLE: the sub-format GUID starts at offset 24.
                    byte[] guidBytes = new byte[16];
                    Marshal.Copy(new IntPtr(mixPtr.ToInt64() + 24), guidBytes, 0, 16);
                    var subFormat = new Guid(guidBytes);
                    isFloat = subFormat == new Guid("00000003-0000-0010-8000-00AA00389B71");
                }
                hr = client.Initialize(0, flags, 2000000, 0, mixPtr, IntPtr.Zero);
                Marshal.FreeCoTaskMem(mixPtr);
                if (hr != 0) throw new COMException("Initialize with mix format failed", hr);
            }

            Guid iidCapture = IID_IAudioCaptureClient;
            object captureRaw;
            hr = client.GetService(ref iidCapture, out captureRaw);
            if (hr != 0) throw new COMException("GetService(IAudioCaptureClient) failed", hr);

            return new CaptureStream
            {
                Name = loopback ? "speaker" : "mic",
                Client = client,
                Capture = (IAudioCaptureClient)captureRaw,
                NativeRate = rate,
                Channels = channels < 1 ? 1 : channels,
                IsFloat = isFloat,
                IsLoopback = loopback,
                previous = 0f
            };
        }

        public void Start()
        {
            int hr = Client.Start();
            if (hr != 0) throw new COMException("IAudioClient.Start failed", hr);
        }

        public void Stop()
        {
            try { Client.Stop(); } catch { }
        }

        /// <summary>Pull every queued packet, downmix to mono and resample to the target rate.</summary>
        public void Pump(List<float> output, int targetRate)
        {
            while (true)
            {
                uint next;
                if (Capture.GetNextPacketSize(out next) != 0 || next == 0) return;

                while (next > 0)
                {
                    IntPtr data;
                    uint frames;
                    uint flags;
                    long devicePosition, qpcPosition;
                    int hr = Capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                    if (hr != 0 || frames == 0)
                    {
                        if (hr == 0) Capture.ReleaseBuffer(frames);
                        return;
                    }

                    bool silent = (flags & 0x2) != 0;
                    if (!silent)
                    {
                        int stride = IsFloat ? 4 : 2;
                        byte[] raw = new byte[(int)frames * Channels * stride];
                        Marshal.Copy(data, raw, 0, raw.Length);
                        for (uint i = 0; i < frames; i++)
                        {
                            float sum = 0f;
                            for (int c = 0; c < Channels; c++)
                            {
                                int offset = (int)((i * Channels + c) * stride);
                                if (IsFloat) sum += BitConverter.ToSingle(raw, offset);
                                else sum += BitConverter.ToInt16(raw, offset) / 32768f;
                            }
                            AddSample(output, sum / Channels, targetRate);
                        }
                    }
                    else
                    {
                        for (uint i = 0; i < frames; i++) AddSample(output, 0f, targetRate);
                    }

                    Capture.ReleaseBuffer(frames);
                    if (Capture.GetNextPacketSize(out next) != 0) return;
                }
            }
        }

        void AddSample(List<float> output, float sample, int targetRate)
        {
            if (NativeRate == targetRate)
            {
                output.Add(sample);
                return;
            }
            double step = (double)NativeRate / targetRate;
            position += 1.0;
            if (position >= step)
            {
                // Linear interpolation between the two most recent native samples.
                double frac = 1.0 - (position - step) / step;
                if (frac > 1.0) frac = 1.0;
                if (frac < 0.0) frac = 0.0;
                output.Add(previous + (float)((sample - previous) * frac));
                position -= step;
            }
            previous = sample;
        }
    }

    internal sealed class SegmentWriter
    {
        readonly string outDir;
        readonly int sampleRate;
        readonly int minFrames;
        readonly int hardFrames;
        readonly int quietFrames;
        readonly int dipLookback;
        readonly int dipWindow;
        readonly int draftStepFrames;
        readonly int draftMinFrames;
        readonly int frameFrames;
        // Levels are tricky on this machine: the loopback can run quiet (a
        // full-volume video measures ~0.01 RMS) while room/music noise sits
        // around 0.003-0.005. An absolute silence threshold therefore cuts inside
        // words (unvoiced consonants are quiet). A pause is instead recognised
        // as 600 ms in which the LOUDEST 20 ms frame stays far below the level of
        // the current utterance: 7% of the take peak (-23 dB) is quiet enough that
        // a breath or a soft word cannot fake it, while real silence still passes.
        const double FloorRms = 0.0012;      // digital-ish silence, safe to drop
        // Idle room noise peaks around 0.003 on this machine; a take must sit
        // clearly above that before a pause is worth closing it.
        const double SpeechFloorRms = 0.004;
        const double PauseRatio = 0.07;      // pause = this much below the speech peak
        const double MaxPauseRms = 0.02;     // never demand more than this
        const double KeepMarginSeconds = 0.15;
        // A take that hits the cap is moved into the quietest 400 ms stretch of
        // the previous 3 s, which is a gap between phrases rather than a syllable
        // boundary. When that stretch is well below the take's own level it is a
        // real gap and the caption may end there; a shallow one (music, noise, a
        // clause) only ends the take and the next one continues the same caption.
        const double CutDepthRatio = 0.2;
        readonly List<short> buffer = new List<short>(16000 * 16);
        int segmentIndex;
        int draftCount;
        int draftAt;
        bool disposed;

        public SegmentWriter(string outDir, int sampleRate, double minSeconds, int maxSeconds)
        {
            this.outDir = outDir;
            this.sampleRate = sampleRate;
            minFrames = (int)(sampleRate * minSeconds);
            hardFrames = sampleRate * maxSeconds;
            if (hardFrames <= minFrames) hardFrames = minFrames + sampleRate;
            quietFrames = sampleRate * 3 / 5;          // 600 ms of real pause
            dipLookback = sampleRate * 3;              // search the last 3 s
            dipWindow = sampleRate * 2 / 5;            // 400 ms: a gap, not a consonant
            draftStepFrames = sampleRate * 3 / 2;      // a draft every 1.5 s
            draftMinFrames = sampleRate;               // but not before 1 s of audio
            frameFrames = sampleRate / 50;             // 20 ms energy frames
        }

        public void Write(short[] samples, int count)
        {
            for (int i = 0; i < count; i++) buffer.Add(samples[i]);
            if (buffer.Count < minFrames) return;
            double peak = PeakFrameRms(buffer.Count);
            if (peak < FloorRms) { buffer.Clear(); draftAt = 0; draftCount = 0; return; }
            if (buffer.Count >= quietFrames && peak >= SpeechFloorRms && TailMaxRms(quietFrames) < PauseLevel(peak))
            {
                // 600 ms with no speech-level frame at all: a real pause. A quiet
                // consonant only lasts tens of milliseconds, so it cannot trigger.
                Emit(buffer.Count, "pause");
                return;
            }
            if (buffer.Count >= hardFrames)
            {
                int cut = FindQuietestCut();
                int width = Math.Min(dipWindow, buffer.Count - cut);
                double level = width > 0 ? FrameRms(cut, width, buffer.Count) : 1;
                double takePeak = PeakFrameRms(cut);
                Emit(cut, takePeak > 0 && level / takePeak <= CutDepthRatio ? "pause" : "cut");
                return;
            }
            // The take is still open: publish what it holds so far, so the first
            // words can be recognised long before the take ends at a pause.
            MaybeDraft();
        }

        /// <summary>
        /// Write the audio collected so far as a "draft" file. The controller
        /// recognises it and shows the text live; the final segment replaces it.
        /// </summary>
        void MaybeDraft()
        {
            if (buffer.Count < draftMinFrames) return;
            if (buffer.Count < draftAt + draftStepFrames) return;
            // Room noise must never be recognised as a caption of its own.
            if (PeakFrameRms(buffer.Count) < SpeechFloorRms) return;
            draftAt = buffer.Count;
            draftCount++;
            string path = Path.Combine(outDir, "draft-" + (segmentIndex + 1).ToString("D6") +
                "-" + draftCount.ToString("D2") + ".wav");
            WriteWav(path, 0, buffer.Count);
            double seconds = (double)buffer.Count / sampleRate;
            Console.WriteLine("{\"type\":\"draft\",\"file\":\"" + Path.GetFileName(path) +
                "\",\"seconds\":" + seconds.ToString("F2") + "}");
            Console.Out.Flush();
        }

        static double PauseLevel(double peak)
        {
            double level = peak * PauseRatio;
            if (level > MaxPauseRms) level = MaxPauseRms;
            return level < FloorRms ? FloorRms : level;
        }

        /** Loudest 20 ms frame in the tail window: one syllable spoils a "pause". */
        double TailMaxRms(int frames)
        {
            if (buffer.Count < frames) return 1;
            int start = buffer.Count - frames;
            double max = 0;
            for (int at = start; at + frameFrames <= buffer.Count; at += frameFrames)
            {
                double rms = FrameRms(at, frameFrames, buffer.Count);
                if (rms > max) max = rms;
            }
            return max;
        }

        /** Trimming keeps the speech and drops the silence around it. */
        static double TrimRms(double peak)
        {
            double level = peak * 0.06;
            return level < 0.0015 ? 0.0015 : level;
        }

        double FrameRms(int start, int frames, int limit)
        {
            if (start < 0) start = 0;
            int end = Math.Min(start + frames, limit);
            if (end <= start) return 0;
            double sum = 0;
            for (int i = start; i < end; i++) { double v = buffer[i] / 32768.0; sum += v * v; }
            return Math.Sqrt(sum / (end - start));
        }

        double PeakFrameRms(int limit)
        {
            double peak = 0;
            for (int start = 0; start < limit; start += frameFrames)
            {
                double rms = FrameRms(start, frameFrames, limit);
                if (rms > peak) peak = rms;
            }
            return peak;
        }

        double BufferRms(int limit)
        {
            if (limit <= 0) return 0;
            double sum = 0;
            for (int i = 0; i < limit; i++) { double v = buffer[i] / 32768.0; sum += v * v; }
            return Math.Sqrt(sum / limit);
        }

        double TailRms(int frames)
        {
            if (buffer.Count < frames || frames <= 0) return 1;
            return FrameRms(buffer.Count - frames, frames, buffer.Count);
        }

        /**
         * Where a take that hit the cap should end: the latest 400 ms stretch of
         * the previous 3 s that is as quiet as the quietest one. The 400 ms window
         * is long enough to still hold a syllable, so a syllable boundary inside a
         * word scores clearly higher than a gap between phrases, and taking the
         * latest near-quiet stretch keeps the take as long as possible.
         */
        int FindQuietestCut()
        {
            int window = dipWindow;
            int end = buffer.Count - window;
            int start = Math.Max(minFrames, buffer.Count - dipLookback);
            if (end <= start) return buffer.Count;
            int total = end + window;
            var sums = new double[total + 1];
            for (int i = 0; i < total; i++)
            {
                double v = buffer[i] / 32768.0;
                sums[i + 1] = sums[i] + v * v;
            }
            double best = double.MaxValue;
            int bestAt = start;
            for (int at = start; at <= end; at += frameFrames)
            {
                double level = (sums[at + window] - sums[at]) / window;
                if (level < best) { best = level; bestAt = at; }
            }
            double limit = best * 1.25;
            for (int at = end; at >= start; at -= frameFrames)
            {
                double level = (sums[at + window] - sums[at]) / window;
                if (level <= limit) return at;
            }
            return bestAt;
        }

        /// <summary>
        /// Write the segment, trimmed to the speech it contains plus a small
        /// margin. A buffer that never rises above the quiet level is dropped
        /// instead of becoming a file the recogniser would only reject.
        /// </summary>
        void Emit(int length, string reason)
        {
            if (length <= 0) return;
            if (length > buffer.Count) length = buffer.Count;
            double peak = PeakFrameRms(length);
            if (peak < FloorRms) { buffer.RemoveRange(0, length); return; }
            double quiet = TrimRms(peak);
            int first = -1;
            int last = -1;
            for (int start = 0; start < length; start += frameFrames)
            {
                if (FrameRms(start, frameFrames, length) >= quiet)
                {
                    if (first < 0) first = start;
                    last = Math.Min(length, start + frameFrames);
                }
            }
            if (first < 0) { buffer.RemoveRange(0, length); return; }
            int margin = (int)(sampleRate * KeepMarginSeconds);
            int begin = Math.Max(0, first - margin);
            int end = Math.Min(length, last + margin);
            int kept = end - begin;
            if (kept < sampleRate / 4) { buffer.RemoveRange(0, length); return; }

            segmentIndex++;
            string path = Path.Combine(outDir, "seg-" + segmentIndex.ToString("D6") + ".wav");
            double sumSquares = WriteWav(path, begin, kept);
            // This take is done: its drafts are stale, and the next take starts a
            // fresh draft cadence.
            DeleteDrafts(segmentIndex);
            draftAt = 0;
            draftCount = 0;
            buffer.RemoveRange(0, length);
            double seconds = (double)kept / sampleRate;
            double rms = Math.Sqrt(sumSquares / kept);
            Console.WriteLine("{\"type\":\"segment\",\"index\":" + segmentIndex +
                ",\"file\":\"" + Path.GetFileName(path) + "\",\"seconds\":" + seconds.ToString("F2") +
                ",\"rms\":" + rms.ToString("F5") + ",\"reason\":\"" + (reason == "cut" ? "cut" : "pause") + "\"}");
            Console.Out.Flush();
        }

        /// <summary>
        /// Write samples [from, from + length) of the buffer as 16 kHz mono WAV and
        /// return the sum of squares of what was written.
        /// </summary>
        double WriteWav(string path, int from, int length)
        {
            double sumSquares = 0;
            using (var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read))
            using (var writer = new BinaryWriter(stream))
            {
                writer.Write(new byte[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' });
                writer.Write((uint)(36 + length * 2));
                writer.Write(new byte[] { (byte)'W', (byte)'A', (byte)'V', (byte)'E' });
                writer.Write(new byte[] { (byte)'f', (byte)'m', (byte)'t', (byte)' ' });
                writer.Write((uint)16);
                writer.Write((ushort)1);
                writer.Write((ushort)1);
                writer.Write((uint)sampleRate);
                writer.Write((uint)(sampleRate * 2));
                writer.Write((ushort)2);
                writer.Write((ushort)16);
                writer.Write(new byte[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a' });
                writer.Write((uint)(length * 2));
                var bytes = new byte[length * 2];
                for (int i = 0; i < length; i++)
                {
                    short value = buffer[from + i];
                    sumSquares += (value / 32768.0) * (value / 32768.0);
                    bytes[i * 2] = (byte)(value & 0xFF);
                    bytes[i * 2 + 1] = (byte)((value >> 8) & 0xFF);
                }
                writer.Write(bytes);
            }
            return sumSquares;
        }

        /// <summary>Drop the draft files of a take the controller may not have read.</summary>
        void DeleteDrafts(int index)
        {
            try
            {
                foreach (string old in Directory.GetFiles(outDir, "draft-" + index.ToString("D6") + "-*.wav"))
                {
                    try { File.Delete(old); } catch { }
                }
            }
            catch { }
        }

        public string DebugJson()
        {
            double peak = PeakFrameRms(buffer.Count);
            return "{\"type\":\"debug\",\"frames\":" + buffer.Count +
                ",\"rms\":" + BufferRms(buffer.Count).ToString("F5") +
                ",\"peak\":" + peak.ToString("F5") +
                ",\"tail\":" + TailRms(quietFrames).ToString("F5") + "}";
        }

        public void Close()
        {
            if (disposed) return;
            disposed = true;
            if (buffer.Count > 0) Emit(buffer.Count, "pause");
        }
    }

    public static class Program
    {
        public static void Run(string outDir, int segmentSeconds, double minSegmentSeconds, string source, int sampleRate)
        {
            bool wantSpeaker = source == "both" || source == "speaker";
            bool wantMic = source == "both" || source == "mic";

            CaptureStream speaker = null;
            CaptureStream mic = null;
            var streams = new List<CaptureStream>();
            try
            {
                if (wantSpeaker)
                {
                    try { speaker = CaptureStream.Open(true, sampleRate); streams.Add(speaker); }
                    catch (Exception ex)
                    {
                        Console.WriteLine("{\"type\":\"warning\",\"warning\":\"speaker capture unavailable: " +
                            Escape(ex.Message) + "\"}");
                    }
                }
                if (wantMic)
                {
                    try { mic = CaptureStream.Open(false, sampleRate); streams.Add(mic); }
                    catch (Exception ex)
                    {
                        Console.WriteLine("{\"type\":\"warning\",\"warning\":\"microphone unavailable: " +
                            Escape(ex.Message) + "\"}");
                    }
                }
                if (streams.Count == 0)
                {
                    Console.WriteLine("{\"type\":\"error\",\"error\":\"no audio endpoint could be opened\"}");
                    return;
                }

                foreach (var s in streams) s.Start();
                Console.WriteLine("{\"type\":\"ready\",\"outDir\":\"" + Escape(outDir) +
                    "\",\"segmentSeconds\":" + segmentSeconds + "}");
                Console.Out.Flush();

                var writer = new SegmentWriter(outDir, sampleRate, minSegmentSeconds, segmentSeconds);
                var speakerBuffer = new List<float>(sampleRate);
                var micBuffer = new List<float>(sampleRate);
                var mixed = new List<short>(sampleRate);
                string stopFlag = Path.Combine(outDir, "stop.flag");
                bool debug = Environment.GetEnvironmentVariable("LC_CAPTURE_DEBUG") == "1";
                long lastDebug = 0;

                while (!File.Exists(stopFlag))
                {
                    speakerBuffer.Clear();
                    micBuffer.Clear();
                    if (speaker != null) speaker.Pump(speakerBuffer, sampleRate);
                    if (mic != null) mic.Pump(micBuffer, sampleRate);

                    int count = Math.Max(speakerBuffer.Count, micBuffer.Count);
                    if (count == 0) { Thread.Sleep(20); continue; }

                    mixed.Clear();
                    for (int i = 0; i < count; i++)
                    {
                        float value = 0f;
                        if (i < speakerBuffer.Count) value += speakerBuffer[i];
                        if (i < micBuffer.Count) value += micBuffer[i];
                        if (value > 1f) value = 1f;
                        else if (value < -1f) value = -1f;
                        mixed.Add((short)(value * 32767f));
                    }
                    writer.Write(mixed.ToArray(), mixed.Count);
                    // LC_CAPTURE_DEBUG=1 prints the live level once a second; it is
                    // how "no sound detected" is told apart from "audio is silent".
                    if (debug && Environment.TickCount - lastDebug > 1000)
                    {
                        lastDebug = Environment.TickCount;
                        Console.WriteLine(writer.DebugJson());
                        Console.Out.Flush();
                    }
                    Thread.Sleep(15);
                }
                writer.Close();
            }
            catch (Exception ex)
            {
                Console.WriteLine("{\"type\":\"error\",\"error\":\"" + Escape(ex.Message) + "\"}");
            }
            finally
            {
                foreach (var s in streams) s.Stop();
            }
        }

        static string Escape(string value)
        {
            if (value == null) return "";
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        }
    }
}
'@

Add-Type -TypeDefinition $csSource -Language CSharp | Out-Null
[DshAudio.Program]::Run($OutDir, $SegmentSeconds, $MinSegmentSeconds, $Source, $SampleRate)
