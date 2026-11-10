import type { CustomTarget } from '../types.js';

/**
 * Words that follow an "@" in CV text without being anyone's handle: Java and
 * TypeScript annotations, Python decorators, and CSS at-rules. A skills line
 * like "Spring (@Transactional, @RestController)" is content the reviewer needs.
 */
const NOT_HANDLES = [
  'Transactional', 'RestController', 'Controller', 'Service', 'Component', 'Repository',
  'Autowired', 'Override', 'Entity', 'Table', 'Column', 'Id', 'Bean', 'Configuration',
  'SpringBootApplication', 'EnableAutoConfiguration', 'RequestMapping', 'GetMapping',
  'PostMapping', 'PutMapping', 'PatchMapping', 'DeleteMapping', 'PathVariable', 'RequestBody',
  'RequestParam', 'ResponseBody', 'Value', 'Valid', 'Async', 'Scheduled', 'Cacheable', 'Query',
  'Param', 'OneToMany', 'ManyToOne', 'ManyToMany', 'OneToOne', 'JoinColumn', 'JsonProperty',
  'Inject', 'Named', 'Singleton', 'Provides', 'Module', 'Test', 'BeforeEach', 'AfterEach',
  'Before', 'After', 'Mock', 'InjectMocks', 'Data', 'Getter', 'Setter', 'Builder', 'Slf4j',
  'Deprecated', 'FunctionalInterface', 'SuppressWarnings', 'Injectable', 'NgModule', 'Input',
  'Output', 'ViewChild', 'HostListener', 'Directive', 'Pipe', 'Get', 'Post', 'Put', 'Delete',
  'Body', 'Kafka', 'KafkaListener', 'EventListener', 'property', 'staticmethod', 'classmethod',
  'dataclass', 'app', 'router', 'pytest', 'media', 'import', 'keyframes', 'font', 'tailwind',
];

/**
 * A social handle such as @someone. Not after a word character, so the host
 * half of an email never matches, not a listed annotation, and not followed by
 * "/", which makes it an npm scope like @ngrx/store or @types/node.
 */
export const HANDLE: CustomTarget = {
  id: 'handle',
  description: 'A social handle such as @someone.',
  patterns: [
    new RegExp(
      `(?<![A-Za-z0-9._%+-])@(?!(?:${NOT_HANDLES.join('|')})(?![A-Za-z0-9_]))` +
        '[A-Za-z0-9_][A-Za-z0-9_.]{1,30}(?![A-Za-z0-9_./])',
      'g',
    ),
  ],
};
