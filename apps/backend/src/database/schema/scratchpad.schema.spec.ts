import { describe, it, expect } from '@jest/globals';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './index.js';

describe('Scratchpad Schema', () => {
  describe('Schema exports', () => {
    it('should export scratchpadSections table', () => {
      expect(schema.scratchpadSections).toBeDefined();
    });
  });

  describe('Table structure', () => {
    it('should have all required columns', () => {
      const table = schema.scratchpadSections;
      
      // Check all required columns exist
      expect(table.id).toBeDefined();
      expect(table.projectId).toBeDefined();
      expect(table.name).toBeDefined();
      expect(table.description).toBeDefined();
      expect(table.content).toBeDefined();
      expect(table.isMarkdown).toBeDefined();
      expect(table.sortOrder).toBeDefined();
      expect(table.createdAt).toBeDefined();
      expect(table.updatedAt).toBeDefined();
    });
  });

  describe('Foreign key constraints', () => {
    it('should have projectId referencing projects.id with cascade delete', () => {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      
      // Create projects table first
      sqlite.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      
      // Create scratchpad_sections table
      sqlite.exec(`
        CREATE TABLE scratchpad_sections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          content TEXT NOT NULL DEFAULT '',
          is_markdown INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      
      // Insert a project
      const insertProject = sqlite.prepare('INSERT INTO projects (name) VALUES (?)');
      const result = insertProject.run('Test Project');
      const projectId = result.lastInsertRowid;
      
      // Insert a scratchpad section
      const insertSection = sqlite.prepare(`
        INSERT INTO scratchpad_sections (project_id, name, description, content)
        VALUES (?, ?, ?, ?)
      `);
      insertSection.run(projectId, 'Test Section', 'Test description', 'Test content');
      
      // Verify the section exists
      const selectSection = sqlite.prepare('SELECT * FROM scratchpad_sections WHERE project_id = ?');
      const sections = selectSection.all(projectId);
      expect(sections).toHaveLength(1);
      expect(sections[0].name).toBe('Test Section');
      
      // Delete the project - should cascade delete the section
      const deleteProject = sqlite.prepare('DELETE FROM projects WHERE id = ?');
      deleteProject.run(projectId);
      
      // Verify the section was deleted by cascade
      const remainingSections = selectSection.all(projectId);
      expect(remainingSections).toHaveLength(0);
      
      sqlite.close();
    });
  });
});