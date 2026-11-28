import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodeIndex, isTestFile, readCodeIndex } from '../src/code.js';
import { codeMap, findSymbol } from '../src/codeview.js';
import { compile } from '../src/compile.js';

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'armature-java-'));
  const write = (rel: string, body: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('armature/system.yaml', 'name: Shop\nheadline: Sells things.\n');
  write('armature/nodes/app.yaml', 'kind: service\nrole: places orders\ncode: [svc/src/main/java/com/acme/app/**]\ntests: [svc/src/test/java/**]\ncalls: [util]\n');
  write('armature/nodes/util.yaml', 'kind: library\nrole: helpers\ncode: [svc/src/main/java/com/acme/util/**, svc/src/main/resources/**]\n');
  write('armature/nodes/model.yaml', 'kind: library\nrole: data\ncode: [svc/src/main/java/com/acme/model/**]\n');
  write(
    'svc/src/main/java/com/acme/app/Service.java',
    [
      'package com.acme.app;',
      '',
      'import com.acme.util.Helper;',
      'import static com.acme.util.Helper.now;',
      'import com.acme.model.*;',
      'import java.util.List;',
      'import lombok.extern.slf4j.Slf4j;',
      '',
      '/**',
      ' * Places orders.',
      ' * @author someone',
      ' */',
      '@Slf4j',
      'public class Service extends Base {',
      '    private final Repo repo;',
      '',
      '    public Service(Repo repo) {',
      '        this.repo = repo;',
      '    }',
      '',
      '    /** Saves one order. */',
      '    public Order place(Order o) {',
      '        Helper.check(o);',
      '        now();',
      '        java.util.function.Supplier<Object> mapper = Mapper::new;',
      '        return repo.save(o);',
      '    }',
      '',
      '    private void hidden() {',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  write('svc/src/main/java/com/acme/app/Base.java', 'package com.acme.app;\n\npublic abstract class Base {\n}\n');
  write('svc/src/main/java/com/acme/app/Repo.java', 'package com.acme.app;\n\nimport com.acme.model.Order;\n\npublic class Repo {\n    public Order save(Order o) {\n        return o;\n    }\n}\n');
  write('svc/src/main/java/com/acme/app/Mapper.java', 'package com.acme.app;\n\npublic class Mapper {\n}\n');
  write('svc/src/main/java/com/acme/app/Dead.java', 'package com.acme.app;\n\nclass Dead {\n}\n');
  write('svc/src/main/java/com/acme/app/DeadBean.java', 'package com.acme.app;\n\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class DeadBean extends Dead {\n}\n');
  write(
    'svc/src/main/java/com/acme/app/FastRepo.java',
    'package com.acme.app;\n\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Component;\nimport com.acme.util.Ext;\n\n@Component\n@Profile("fast")\npublic class FastRepo extends Repo {\n    private final Ext ext = null;\n}\n',
  );
  write('svc/src/main/java/com/acme/util/Helper.java', 'package com.acme.util;\n\npublic class Helper {\n    public static void check(Object o) {\n    }\n\n    public static long now() {\n        return 0;\n    }\n}\n');
  write('svc/src/main/java/com/acme/util/Ext.java', 'package com.acme.util;\n\npublic class Ext {\n}\n');
  write('svc/src/main/java/com/acme/util/Registered.java', 'package com.acme.util;\n\npublic class Registered {\n}\n');
  write('svc/src/main/resources/META-INF/services/com.acme.Plugin', '# registered by name\ncom.acme.util.Registered\n');
  write('svc/src/main/java/com/acme/model/Order.java', 'package com.acme.model;\n\nimport java.util.List;\n\npublic record Order(String id, int amount, Status status, List<String> tags) {\n}\n');
  write('svc/src/main/java/com/acme/model/Status.java', 'package com.acme.model;\n\npublic enum Status {\n    NEW, PAID\n}\n');
  write('svc/src/main/java/com/acme/model/Address.java', 'package com.acme.model;\n\nimport lombok.Data;\n\n@Data\npublic class Address {\n    private static final int MAX = 1;\n    private String city;\n    private Integer zip;\n}\n');
  write(
    'svc/src/test/java/com/acme/app/ServiceTest.java',
    'package com.acme.app;\n\nimport org.junit.jupiter.api.Test;\n\nclass ServiceTest {\n    @Test\n    void placesOrder() {\n        new Service(new Repo()).place(null);\n    }\n}\n',
  );
  // Started by the framework or the JVM, and named by nobody.
  write('svc/src/main/java/com/acme/app/App.java', 'package com.acme.app;\n\npublic class App {\n    public static void main(String[] args) {\n    }\n}\n');
  write('svc/src/main/java/com/acme/app/OrderController.java', 'package com.acme.app;\n\nimport org.springframework.web.bind.annotation.RestController;\n\n@RestController\npublic class OrderController {\n}\n');
  write('svc/src/main/java/com/acme/app/Nightly.java', 'package com.acme.app;\n\nimport org.springframework.scheduling.annotation.Scheduled;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class Nightly {\n    @Scheduled(cron = "0 0 3 * * *")\n    void run() {\n    }\n}\n');
  write('svc/src/main/java/com/acme/app/Startup.java', 'package com.acme.app;\n\nimport org.springframework.boot.CommandLineRunner;\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class Startup implements CommandLineRunner {\n    public void run(String... args) {\n    }\n}\n');
  // A component with no supertype that nobody names stays dead; a class is not a test because of a word in its name.
  write('svc/src/main/java/com/acme/app/Unused.java', 'package com.acme.app;\n\nimport org.springframework.stereotype.Component;\n\n@Component\npublic class Unused {\n}\n');
  write('svc/src/main/java/com/acme/app/HealthCheck.java', 'package com.acme.app;\n\npublic class HealthCheck {\n}\n');
  write('svc/src/test/java/com/acme/app/OrderRules.java', 'package com.acme.app;\n\nimport org.junit.jupiter.api.Test;\n\nclass OrderRules {\n    @Test\n    void holds() {\n    }\n}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

describe('java code index', () => {
  it('extracts types and public methods, and resolves explicit, static, wildcard and same-package imports', async () => {
    const root = repo();
    const r = await buildCodeIndex(root);
    expect(r.parsed).toBe(21);
    expect(r.index.files['svc/src/main/java/com/acme/app/FastRepo.java'].hints).toContainEqual({ k: 'bean', v: 'Repo', op: 'extends', l: 7 });
    const f = r.index.files['svc/src/main/java/com/acme/app/Service.java'];
    expect(f.lang).toBe('java');
    expect(f.test).toBe(false);
    expect(f.symbols.find((s) => s.name === 'Service')).toMatchObject({ kind: 'class', exported: true, doc: 'Places orders.' });
    expect(f.symbols.find((s) => s.name === 'Service')!.sig).toContain('public class Service extends Base');
    expect(f.symbols.find((s) => s.name === 'Service.place')).toMatchObject({ kind: 'function', exported: true, sig: 'public Order place(Order o)', doc: 'Saves one order.' });
    expect(f.symbols.some((s) => s.name === 'Service.hidden')).toBe(false);
    const resolved = f.imports.map((i) => `${i.spec}>${i.file ?? `pkg:${i.pkg}`}`).sort();
    expect(resolved).toEqual([
      'com.acme.app.Base>svc/src/main/java/com/acme/app/Base.java',
      'com.acme.app.Mapper>svc/src/main/java/com/acme/app/Mapper.java',
      'com.acme.app.Repo>svc/src/main/java/com/acme/app/Repo.java',
      'com.acme.model>svc/src/main/java/com/acme/model/Address.java',
      'com.acme.model>svc/src/main/java/com/acme/model/Order.java',
      'com.acme.model>svc/src/main/java/com/acme/model/Status.java',
      'com.acme.util.Helper>svc/src/main/java/com/acme/util/Helper.java',
      'com.acme.util.Helper>svc/src/main/java/com/acme/util/Helper.java',
      'java.util.List>pkg:java.util',
      'lombok.extern.slf4j.Slf4j>pkg:lombok.extern.slf4j',
    ]);
    // Uses are attributed to the method they sit in, and a call counts as one.
    expect(f.refs.find((x) => x.n === 'Helper')).toMatchObject({ in: 'Service.place', c: 1 });
    expect(f.refs.find((x) => x.n === 'now')).toMatchObject({ in: 'Service.place', c: 1 });
    expect(f.refs.find((x) => x.n === 'Repo')).toMatchObject({ in: 'Service', c: 0 });
    expect(r.index.files['svc/src/test/java/com/acme/app/ServiceTest.java'].refs.find((x) => x.n === 'Repo')).toMatchObject({ in: 'ServiceTest.placesOrder', c: 1 });
    // Records and Lombok classes are data shapes; static fields are not part of them.
    expect(r.index.files['svc/src/main/java/com/acme/model/Order.java'].schemas.Order).toEqual({ kind: 'java', fields: [{ name: 'id', type: 'string' }, { name: 'amount', type: 'int' }, { name: 'status', type: 'Status' }, { name: 'tags', type: 'string[]' }] });
    expect(r.index.files['svc/src/main/java/com/acme/model/Address.java'].schemas.Address).toEqual({ kind: 'java', fields: [{ name: 'city', type: 'string' }, { name: 'zip', type: 'int' }] });
    expect(r.index.files['svc/src/main/java/com/acme/model/Status.java'].enums).toEqual({ Status: 'enum(NEW|PAID)' });
    expect(r.index.files['svc/src/test/java/com/acme/app/ServiceTest.java'].test).toBe(true);
    // A class with test methods is a test whatever its name; a word in a name does not make one.
    expect(r.index.files['svc/src/test/java/com/acme/app/OrderRules.java'].test).toBe(true);
    expect(r.index.files['svc/src/main/java/com/acme/app/HealthCheck.java'].test).toBe(false);
  });

  it('tells test classes by name, not by the src/test folder', () => {
    for (const name of ['ServiceTest', 'ServiceTests', 'ServiceTestCase', 'ServiceIT', 'ServiceITCase', 'TestService', 'ITService']) {
      expect(isTestFile(`svc/src/test/java/com/acme/app/${name}.java`), name).toBe(true);
    }
    for (const name of ['ServiceHook', 'HealthCheck', 'Latest', 'Item']) expect(isTestFile(`svc/src/test/java/com/acme/app/${name}.java`), name).toBe(false);
    // Test* and IT* are names of tests only inside a test source set.
    expect(isTestFile('svc/src/main/java/com/acme/app/TestService.java')).toBe(false);
    expect(isTestFile('svc/src/integrationTest/java/com/acme/app/ITService.java')).toBe(true);
    expect(isTestFile('apps/web/tests/login.ts')).toBe(true);
  });

  it('classifies node-to-node imports, finds dead classes, and keeps classes a service file registers', async () => {
    const root = repo();
    await buildCodeIndex(root);
    const g = compile(root);
    const kinds = Object.fromEntries(g.codeDeps.map((d) => [`${d.from}>${d.to}`, d.kind]));
    expect(kinds).toEqual({ 'app>util': 'declared', 'app>model': 'library' });
    // FastRepo is wired by Spring as a Repo, so it lives, and so does the Ext it imports; a bean of a dead supertype is dead too.
    // A main method, a controller, a scheduled job and a bean of a library type are started without being named.
    expect(g.dead.map((d) => d.path)).toEqual([
      'svc/src/main/java/com/acme/app/Dead.java',
      'svc/src/main/java/com/acme/app/DeadBean.java',
      'svc/src/main/java/com/acme/app/HealthCheck.java',
      'svc/src/main/java/com/acme/app/Unused.java',
    ]);
    expect(g.problems.some((p) => p.code === 'unread-node')).toBe(false);
    const idx = readCodeIndex(root)!;
    const map = codeMap(g, idx, 'app');
    expect(map).toContain('public Order place(Order o)');
    expect(map).not.toContain('hidden');
    expect(findSymbol(g, idx, 'Helper')).toContain('svc/src/main/java/com/acme/util/Helper.java:3 [util]');
  });
});
