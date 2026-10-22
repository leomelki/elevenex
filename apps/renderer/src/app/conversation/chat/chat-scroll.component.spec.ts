import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { ChatScrollComponent } from "./chat-scroll.component";
import { MessageComponent } from "./message.component";
@Component({
  selector: "ex-scroll-test",
  imports: [ChatScrollComponent, MessageComponent],
  template:
    '<ex-chat-scroll [startAtEnd]="false"><ex-message role="user" messageId="first">Explain this behavior</ex-message><p>A long reply</p></ex-chat-scroll>',
})
class ScrollTestComponent {}

describe("ChatScroll resource ownership", () => {
  it("disconnects owned observers and cancels scheduled work when the chat closes", async () => {
    const resizeDisconnected = vi.fn();
    const mutationDisconnected = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {
          resizeDisconnected();
        }
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe(): void {}
        disconnect(): void {
          mutationDisconnected();
        }
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await TestBed.configureTestingModule({
      imports: [ScrollTestComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScrollTestComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.destroy();
    expect(resizeDisconnected).toHaveBeenCalledOnce();
    expect(mutationDisconnected).toHaveBeenCalledOnce();
  });
});
