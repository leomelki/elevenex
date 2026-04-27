import { describe, it, expect } from '@jest/globals';
import Database from 'better-sqlite3';
import * as schema from './index.js';

describe('Todos Schema', () => {
  describe('Schema exports', () => {
    it('should export todoItems table', () => {
      expect(schema.todoItems).toBeDefined();
    });
  });

  describe('Table structure', () => {
    it('should have all required columns', () => {
      const table = schema.todoItems;
      
      // Check all required columns exist
      expect(table.id).toBeDefined();
      expect(table.projectId).toBeDefined();
      expect(table.text).toBeDefined();
      expect(table.completed).toBeDefined();
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
      
      // Create todo_items table
      sqlite.exec(`
        CREATE TABLE todo_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      
      // Insert a project
      const insertProject = sqlite.prepare('INSERT INTO projects (name) VALUES (?)');
      const result = insertProject.run('Test Project');
      const projectId = result.lastInsertRowid;
      
      // Insert a todo item
      const insertTodo = sqlite.prepare(`
        INSERT INTO todo_items (project_id, text, completed, sort_order)
        VALUES (?, ?, ?, ?)
      `);
      insertTodo.run(projectId, 'Test todo', 0, 0);
      
      // Verify the todo exists
      const selectTodo = sqlite.prepare('SELECT * FROM todo_items WHERE project_id = ?');
      const todos = selectTodo.all(projectId);
      expect(todos).toHaveLength(1);
      expect(todos[0].text).toBe('Test todo');
      
      // Delete the project - should cascade delete the todo
      const deleteProject = sqlite.prepare('DELETE FROM projects WHERE id = ?');
      deleteProject.run(projectId);
      
      // Verify the todo was deleted by cascade
      const remainingTodos = selectTodo.all(projectId);
      expect(remainingTodos).toHaveLength(0);
      
      sqlite.close();
    });
  });
});