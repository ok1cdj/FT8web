/**
 * Generates an object URL for the AudioWorkletProcessor script.
 * We do this via Blob to avoid Vite public folder static asset issues and 
 * keep the component completely self-contained.
 */
export const getCaptureWorkletUrl = (): string => {
    const code = `
    class CaptureProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buffer = [];
      }
  
      process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        
        // Output strict silence to destination to avoid feedback loop,
        // but satisfy browsers that need connected worklets to stay active.
        if (output) {
          for (let channel = 0; channel < output.length; ++channel) {
              const outputChannel = output[channel];
              for (let i = 0; i < outputChannel.length; ++i) {
                  outputChannel[i] = 0;
              }
          }
        }
  
        if (input && input.length > 0 && input[0].length > 0) {
          // Fail-safe to avoid massive leaks if main thread blocks
          if (this.buffer.length > 48000 * 20) {
              this.buffer = []; 
          }
          
          // Accumulate raw PCM input
          this.buffer.push(...input[0]);
          
          // Push to main thread in clean chunks
          if (this.buffer.length >= 4096) {
              const toSend = new Float32Array(this.buffer.slice(0, 4096));
              this.port.postMessage(toSend);
              this.buffer = this.buffer.slice(4096);
          }
        }
        
        return true; 
      }
    }
    
    registerProcessor('capture-processor', CaptureProcessor);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  };
