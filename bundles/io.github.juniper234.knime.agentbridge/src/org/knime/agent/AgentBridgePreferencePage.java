package org.knime.agent;

import org.eclipse.core.runtime.preferences.InstanceScope;
import org.eclipse.jface.preference.BooleanFieldEditor;
import org.eclipse.jface.preference.FieldEditorPreferencePage;
import org.eclipse.swt.SWT;
import org.eclipse.swt.widgets.Label;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPreferencePage;
import org.eclipse.ui.preferences.ScopedPreferenceStore;

/** Preferences > KNIME > Agent Bridge. */
public final class AgentBridgePreferencePage extends FieldEditorPreferencePage implements IWorkbenchPreferencePage {
    public AgentBridgePreferencePage() {
        super(GRID);
        ScopedPreferenceStore store=new ScopedPreferenceStore(InstanceScope.INSTANCE,WritePolicy.NODE);
        store.setDefault(WritePolicy.KEY,WritePolicy.DEFAULT);
        setPreferenceStore(store);
        setDescription("AI agents connected through the Agent Bridge can always read open workflows, settings and tables. "
            +"Turn off the option below to keep them read-only.");
    }
    @Override public void init(IWorkbench workbench) {}
    @Override protected void createFieldEditors() {
        addField(new BooleanFieldEditor(WritePolicy.KEY,"Allow AI agents to modify, execute and save workflows",getFieldEditorParent()));
        String property=System.getProperty(WritePolicy.PROPERTY);
        if(property!=null&&!property.isBlank()) {
            Label note=new Label(getFieldEditorParent(),SWT.WRAP);
            note.setText("This KNIME was started with -D"+WritePolicy.PROPERTY+"="+property.trim()+", which overrides this setting.");
        }
    }
}
