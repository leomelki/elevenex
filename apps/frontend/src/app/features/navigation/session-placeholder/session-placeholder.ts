import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SessionsService } from '../../../shared/services/sessions.service';
import { Session } from '../../../shared/models/session.model';

@Component({
  selector: 'app-session-placeholder',
  templateUrl: './session-placeholder.html',
})
export class SessionPlaceholder implements OnInit {
  private route = inject(ActivatedRoute);
  private sessionsService = inject(SessionsService);
  session = signal<Session | null>(null);

  ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.sessionsService.getOne(id).subscribe({
      next: (s) => this.session.set(s),
    });
  }
}